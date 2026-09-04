import { parseArgs } from 'node:util';
import { NavApiError, NavTransportError, NavValidationError } from '@open-nav/core';
import { COMMANDS, describeCommands, findCommand, type CommandContext } from './commands.js';
import { ENV_VARS } from './config.js';
import { EXIT, UsageError, type ExitCode } from './errors.js';
import { consoleWriter, resolveFormat, writeError, type Format, type Writer } from './output.js';

export interface RunOptions {
  argv: string[];
  writer?: Writer;
  /** Whether stdout is a terminal, which decides the default output format. */
  isTty?: boolean;
  env?: Record<string, string | undefined>;
  cwd?: string;
  readFile?: (path: string) => string;
  writeFile?: (path: string, contents: string) => void;
}

const GLOBAL_OPTIONS = {
  json: { type: 'boolean' },
  pretty: { type: 'boolean' },
  'env-file': { type: 'string' },
  'no-env-file': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean' },
  describe: { type: 'boolean' },
} as const;

/**
 * Run the CLI and return an exit code.
 *
 * Everything is injectable so the whole surface can be tested without
 * spawning a process or touching the filesystem.
 */
export async function run(options: RunOptions): Promise<ExitCode> {
  const writer = options.writer ?? consoleWriter;

  let parsed;
  try {
    parsed = parseArgs({
      args: options.argv,
      options: {
        ...GLOBAL_OPTIONS,
        // Command options are accepted loosely here and validated by the
        // command, so a new option never needs registering in two places.
        operation: { type: 'string' },
        language: { type: 'string' },
        direction: { type: 'string' },
        supplier: { type: 'string' },
        from: { type: 'string' },
        to: { type: 'string' },
        page: { type: 'string' },
        wait: { type: 'boolean' },
        compress: { type: 'boolean' },
        xml: { type: 'boolean' },
        'skip-validation': { type: 'boolean' },
        out: { type: 'string' },
        note: { type: 'string' },
        'number-from': { type: 'string' },
        'number-to': { type: 'string' },
        'warnings-as-errors': { type: 'boolean' },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (cause) {
    writer.err((cause as Error).message);
    writer.err('Run "open-nav --help" for usage.');
    return EXIT.usage;
  }

  const flags = parsed.values as Record<string, string | boolean | undefined>;
  const explicitFormat: Format | undefined =
    flags['json'] === true ? 'json' : flags['pretty'] === true ? 'text' : undefined;
  const format = resolveFormat(explicitFormat, options.isTty ?? false);

  if (flags['describe'] === true) {
    writer.out(JSON.stringify(describeCommands(), null, 2));
    return EXIT.ok;
  }

  if (flags['version'] === true) {
    writer.out(VERSION);
    return EXIT.ok;
  }

  const [commandName, ...positionals] = parsed.positionals;

  if (flags['help'] === true || commandName === undefined || commandName === 'help') {
    const topic = commandName === 'help' ? positionals[0] : undefined;
    writeHelp(writer, topic);
    return commandName === undefined && flags['help'] !== true ? EXIT.usage : EXIT.ok;
  }

  const command = findCommand(commandName);
  if (!command) {
    writer.err(`Unknown command: ${commandName}`);
    writer.err(`Available: ${COMMANDS.map((entry) => entry.name).join(', ')}`);
    return EXIT.usage;
  }

  const context: CommandContext = {
    format,
    writer,
    load: {
      ...(flags['env-file'] ? { envFile: String(flags['env-file']) } : {}),
      ...(flags['no-env-file'] === true ? { noEnvFile: true } : {}),
      ...(options.env ? { env: options.env } : {}),
      ...(options.cwd ? { cwd: options.cwd } : {}),
    },
    ...(options.readFile ? { readFile: options.readFile } : {}),
    ...(options.writeFile ? { writeFile: options.writeFile } : {}),
  };

  try {
    return await command.run(positionals, flags, context);
  } catch (error) {
    return reportError(writer, format, command.name, error);
  }
}

function reportError(writer: Writer, format: Format, command: string, error: unknown): ExitCode {
  if (error instanceof UsageError) {
    writeError(writer, format, command, { message: error.message, code: 'USAGE' });
    return EXIT.usage;
  }
  if (error instanceof NavApiError) {
    writeError(writer, format, command, {
      message: error.message,
      ...(error.errorCode ? { code: error.errorCode } : {}),
      details: {
        status: error.status,
        funcCode: error.funcCode,
        validationMessages: error.validationMessages,
      },
    });
    return EXIT.rejected;
  }
  if (error instanceof NavValidationError) {
    writeError(writer, format, command, {
      message: error.message,
      code: 'INVALID',
      details: error.issues,
    });
    return EXIT.invalid;
  }
  if (error instanceof NavTransportError) {
    writeError(writer, format, command, { message: error.message, code: 'UNAVAILABLE' });
    return EXIT.unavailable;
  }
  writeError(writer, format, command, { message: (error as Error).message ?? String(error) });
  return EXIT.failure;
}

const VERSION = '0.1.0';

function writeHelp(writer: Writer, topic: string | undefined): void {
  if (topic === 'config') {
    writer.out('Configuration is read from the environment, or from a .env file');
    writer.out('discovered by walking up from the working directory.');
    writer.out('');
    writer.out('Required:');
    for (const variable of [
      ENV_VARS.login,
      ENV_VARS.password,
      ENV_VARS.signKey,
      ENV_VARS.exchangeKey,
      ENV_VARS.taxNumber,
      ENV_VARS.softwareId,
    ]) {
      writer.out(`  ${variable}`);
    }
    writer.out('');
    writer.out('Optional:');
    for (const variable of [
      ENV_VARS.environment,
      ENV_VARS.softwareName,
      ENV_VARS.softwareVersion,
      ENV_VARS.softwareOperation,
      ENV_VARS.softwareDevName,
      ENV_VARS.softwareDevContact,
      ENV_VARS.softwareDevTaxNumber,
      ENV_VARS.baseUrl,
    ]) {
      writer.out(`  ${variable}`);
    }
    writer.out('');
    writer.out(`${ENV_VARS.environment} defaults to "test". Set it to "production" deliberately.`);
    writer.out(`${ENV_VARS.taxNumber} is the 8 digit core tax number, not the 11 digit form.`);
    writer.out('');
    writer.out('Credentials are never taken as command line arguments: they would');
    writer.out('be recorded in shell history, process listings and agent transcripts.');
    return;
  }

  if (topic !== undefined) {
    const command = findCommand(topic);
    if (!command) {
      writer.err(`Unknown command: ${topic}`);
      return;
    }
    writer.out(command.summary);
    writer.out('');
    writer.out(`  ${command.usage}`);
    if (command.options && command.options.length > 0) {
      writer.out('');
      const width = Math.max(...command.options.map((option) => option.flag.length));
      for (const option of command.options) {
        writer.out(`  ${option.flag.padEnd(width)}  ${option.description}`);
      }
    }
    if (command.needsCredentials) {
      writer.out('');
      writer.out('Needs credentials. Run "open-nav config" to check them.');
    }
    return;
  }

  writer.out('open-nav — command line access to the NAV Online Számla invoice service');
  writer.out('');
  writer.out('  open-nav <command> [options]');
  writer.out('');
  const width = Math.max(...COMMANDS.map((command) => command.name.length));
  for (const command of COMMANDS) {
    writer.out(`  ${command.name.padEnd(width)}  ${command.summary}`);
  }
  writer.out('');
  writer.out('Options:');
  writer.out('  --json              Output JSON (the default when not a terminal)');
  writer.out('  --pretty            Output human readable text');
  writer.out('  --env-file <path>   Read configuration from this file');
  writer.out('  --no-env-file       Ignore .env files entirely');
  writer.out('  --describe          Print the command surface as JSON, for tooling');
  writer.out('  --version           Print the version');
  writer.out('');
  writer.out('Exit codes: 0 ok, 2 usage, 3 invalid document, 4 rejected by NAV, 5 unavailable.');
  writer.out('');
  writer.out('Help on a command:      open-nav help <command>');
  writer.out('Help on configuration:  open-nav help config');
}
