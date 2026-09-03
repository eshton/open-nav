import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { SoftwareType } from '@open-nav/core';
import type { NavCredentials } from '@open-nav/client';
import { UsageError } from './errors.js';

/**
 * Configuration comes from the environment, optionally seeded from a local
 * env file. Credentials are never accepted as command line arguments: they
 * would end up in shell history, in process listings and in any agent
 * transcript that records the command.
 */
export const ENV_VARS = {
  environment: 'NAV_ENVIRONMENT',
  login: 'NAV_LOGIN',
  password: 'NAV_PASSWORD',
  signKey: 'NAV_SIGN_KEY',
  exchangeKey: 'NAV_EXCHANGE_KEY',
  taxNumber: 'NAV_TAX_NUMBER',
  softwareId: 'NAV_SOFTWARE_ID',
  softwareName: 'NAV_SOFTWARE_NAME',
  softwareVersion: 'NAV_SOFTWARE_VERSION',
  softwareDevName: 'NAV_SOFTWARE_DEV_NAME',
  softwareDevContact: 'NAV_SOFTWARE_DEV_CONTACT',
  softwareDevTaxNumber: 'NAV_SOFTWARE_DEV_TAX_NUMBER',
  softwareOperation: 'NAV_SOFTWARE_OPERATION',
  baseUrl: 'NAV_BASE_URL',
} as const;

/** Variables that hold secrets and must never be printed. */
export const SECRET_VARS = new Set<string>([
  ENV_VARS.password,
  ENV_VARS.signKey,
  ENV_VARS.exchangeKey,
]);

const ENV_FILE_NAMES = ['.env.open-nav', '.env.local', '.env'];

/** Variables without which nothing can talk to NAV. */
export const REQUIRED_VARS: readonly string[] = [
  ENV_VARS.login,
  ENV_VARS.password,
  ENV_VARS.signKey,
  ENV_VARS.exchangeKey,
  ENV_VARS.taxNumber,
  ENV_VARS.softwareId,
];

/** Defaults applied when an optional variable is unset. */
export const DEFAULTS: Readonly<Record<string, string>> = {
  [ENV_VARS.environment]: 'test',
  [ENV_VARS.softwareName]: 'open-nav',
  [ENV_VARS.softwareVersion]: '0.1.0',
  [ENV_VARS.softwareOperation]: 'LOCAL_SOFTWARE',
  [ENV_VARS.softwareDevName]: 'open-nav',
  [ENV_VARS.softwareDevContact]: 'unknown',
};

export interface LoadedConfig {
  credentials: NavCredentials;
  software: SoftwareType;
  environment: 'test' | 'production';
  baseUrl?: string;
  /** Env files that were read, nearest first. */
  envFiles: string[];
}

/**
 * Parse a `.env` file.
 *
 * Deliberately minimal: `KEY=value`, `#` comments, optional `export`, and
 * single or double quotes stripped. Anything more elaborate belongs in a real
 * secret manager, not in a file next to the source.
 */
export function parseEnvFile(contents: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const withoutExport = line.startsWith('export ') ? line.slice('export '.length) : line;
    const separator = withoutExport.indexOf('=');
    if (separator === -1) continue;
    const key = withoutExport.slice(0, separator).trim();
    let value = withoutExport.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    if (key !== '') values[key] = value;
  }
  return values;
}

/**
 * Find env files, walking up from a starting directory.
 *
 * Walking up means a project-level env file is picked up from any
 * subdirectory, which is how an agent invoked in a nested working directory
 * still finds the credentials.
 */
export function discoverEnvFiles(from: string): string[] {
  const found: string[] = [];
  let directory = resolve(from);
  for (;;) {
    for (const name of ENV_FILE_NAMES) {
      const candidate = resolve(directory, name);
      if (existsSync(candidate)) found.push(candidate);
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return found;
}

export interface LoadOptions {
  /** Explicit env file, from `--env-file`. Takes precedence over discovery. */
  envFile?: string;
  /** Where to start looking. Defaults to the working directory. */
  cwd?: string;
  /** Process environment. Injectable for tests. */
  env?: Record<string, string | undefined>;
  /** Skip env file discovery entirely. */
  noEnvFile?: boolean;
}

/** Read the environment, seeded from env files, without requiring credentials. */
export function loadEnvironment(options: LoadOptions = {}): {
  env: Record<string, string | undefined>;
  envFiles: string[];
} {
  const base = { ...(options.env ?? process.env) };
  const envFiles: string[] = [];

  if (options.envFile) {
    if (!existsSync(options.envFile)) {
      throw new UsageError(`Env file not found: ${options.envFile}`);
    }
    envFiles.push(resolve(options.envFile));
  } else if (!options.noEnvFile) {
    envFiles.push(...discoverEnvFiles(options.cwd ?? process.cwd()));
  }

  // Real environment variables win over files, and a nearer file wins over a
  // more distant one.
  for (const file of envFiles) {
    for (const [key, value] of Object.entries(parseEnvFile(readFileSync(file, 'utf8')))) {
      base[key] ??= value;
    }
  }

  return { env: base, envFiles };
}

export interface ConfigVariableReport {
  variable: string;
  set: boolean;
  required: boolean;
  secret: boolean;
  /** Present for non-secret variables that are set. */
  value?: string;
  /** Value that applies when the variable is left unset. */
  default?: string;
}

/**
 * Which configuration variables are present, for the `config` command.
 *
 * Required and optional are reported separately: an unset optional variable
 * with a working default is not a problem, and listing it as "missing" sends
 * people hunting for something that is not wrong.
 */
export function describeConfig(env: Record<string, string | undefined>): ConfigVariableReport[] {
  return Object.values(ENV_VARS).map((variable) => {
    const value = env[variable];
    const secret = SECRET_VARS.has(variable);
    const set = value !== undefined && value !== '';
    const fallback = DEFAULTS[variable];
    return {
      variable,
      set,
      required: REQUIRED_VARS.includes(variable),
      secret,
      ...(set && !secret ? { value } : {}),
      ...(!set && fallback !== undefined ? { default: fallback } : {}),
    };
  });
}

/**
 * Assemble the full configuration, failing with a list of everything missing
 * rather than one variable at a time.
 */
export function loadConfig(options: LoadOptions = {}): LoadedConfig {
  const { env, envFiles } = loadEnvironment(options);

  const missing = REQUIRED_VARS.filter((variable) => !env[variable]);
  if (missing.length > 0) {
    throw new UsageError(
      `Missing configuration: ${missing.join(', ')}.\n` +
        `Set them in the environment or in a .env file, then run "open-nav config" to check.\n` +
        `See "open-nav help config" for the full list.`,
    );
  }

  const environmentRaw = env[ENV_VARS.environment] ?? 'test';
  if (environmentRaw !== 'test' && environmentRaw !== 'production') {
    throw new UsageError(
      `${ENV_VARS.environment} must be "test" or "production", got ${JSON.stringify(environmentRaw)}`,
    );
  }

  const operationRaw = env[ENV_VARS.softwareOperation] ?? 'LOCAL_SOFTWARE';
  if (operationRaw !== 'LOCAL_SOFTWARE' && operationRaw !== 'ONLINE_SERVICE') {
    throw new UsageError(
      `${ENV_VARS.softwareOperation} must be "LOCAL_SOFTWARE" or "ONLINE_SERVICE", got ${JSON.stringify(operationRaw)}`,
    );
  }

  return {
    credentials: {
      login: env[ENV_VARS.login]!,
      password: env[ENV_VARS.password]!,
      signKey: env[ENV_VARS.signKey]!,
      exchangeKey: env[ENV_VARS.exchangeKey]!,
      taxNumber: env[ENV_VARS.taxNumber]!,
    },
    software: {
      softwareId: env[ENV_VARS.softwareId]!,
      softwareName: env[ENV_VARS.softwareName] ?? 'open-nav',
      softwareOperation: operationRaw,
      softwareMainVersion: env[ENV_VARS.softwareVersion] ?? '0.1.0',
      softwareDevName: env[ENV_VARS.softwareDevName] ?? 'open-nav',
      softwareDevContact: env[ENV_VARS.softwareDevContact] ?? 'unknown',
      ...(env[ENV_VARS.softwareDevTaxNumber]
        ? { softwareDevTaxNumber: env[ENV_VARS.softwareDevTaxNumber] }
        : {}),
    },
    environment: environmentRaw,
    ...(env[ENV_VARS.baseUrl] ? { baseUrl: env[ENV_VARS.baseUrl] } : {}),
    envFiles,
  };
}
