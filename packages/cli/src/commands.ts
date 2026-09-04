import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  NavApiError,
  faultMessage,
  parseDocument,
  parseTaxNumber,
  serializeDocument,
  validateInvoice,
  type InvoiceData,
  type InvoiceValidationIssue,
} from '@open-nav/core';
import { NavClient, waitForTransaction } from '@open-nav/client';
import { createDataExport, renderInvoiceHtml } from '@open-nav/invoicing';
import { EXIT, UsageError, type ExitCode } from './errors.js';
import { describeConfig, loadConfig, loadEnvironment, type LoadOptions } from './config.js';
import { renderFields, renderIssues, writeResult, type Format, type Writer } from './output.js';

export interface CommandContext {
  format: Format;
  writer: Writer;
  load: LoadOptions;
  /** Read a file, so tests need no filesystem. */
  readFile?: (path: string) => string;
  /** Write a file, creating parent directories. Injectable for tests. */
  writeFile?: (path: string, contents: string) => void;
}

export interface CommandDefinition {
  name: string;
  summary: string;
  usage: string;
  /** True when the command talks to NAV and therefore needs credentials. */
  needsCredentials: boolean;
  options?: Array<{ flag: string; description: string }>;
  run: (
    positionals: string[],
    flags: Record<string, string | boolean | undefined>,
    context: CommandContext,
  ) => Promise<ExitCode>;
}

function client(context: CommandContext): NavClient {
  const config = loadConfig(context.load);
  return new NavClient({
    credentials: config.credentials,
    software: config.software,
    environment: config.environment,
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
  });
}

function readInput(path: string, context: CommandContext): string {
  const read = context.readFile ?? ((target: string) => readFileSync(target, 'utf8'));
  return path === '-' ? read('/dev/stdin') : read(path);
}

function writeOutput(path: string, contents: string, context: CommandContext): void {
  if (context.writeFile) {
    context.writeFile(path, contents);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, 'utf8');
}

/** Read an InvoiceData document, failing clearly if it is something else. */
function readInvoice(path: string, context: CommandContext): InvoiceData {
  const parsed = parseDocument(readInput(path, context), { unknownElements: 'ignore' });
  if (parsed.root !== 'InvoiceData') {
    throw new UsageError(`${path}: expected an InvoiceData document, found ${parsed.root}`);
  }
  return parsed.value as InvoiceData;
}

function requirePositional(positionals: string[], index: number, name: string): string {
  const value = positionals[index];
  if (value === undefined || value === '') throw new UsageError(`Missing <${name}>`);
  return value;
}

function direction(flags: Record<string, string | boolean | undefined>): 'INBOUND' | 'OUTBOUND' {
  const value = flags['direction'] ?? 'OUTBOUND';
  const upper = String(value).toUpperCase();
  if (upper !== 'INBOUND' && upper !== 'OUTBOUND') {
    throw new UsageError('--direction must be inbound or outbound');
  }
  return upper;
}

function issueSummary(issues: InvoiceValidationIssue[]): string {
  const errors = issues.filter((issue) => issue.severity === 'error').length;
  const warnings = issues.length - errors;
  return `${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}`;
}

export const COMMANDS: CommandDefinition[] = [
  {
    name: 'config',
    summary: 'Show which configuration variables are set, without revealing secrets',
    usage: 'open-nav config',
    needsCredentials: false,
    async run(_positionals, _flags, context) {
      const { env, envFiles } = loadEnvironment(context.load);
      const variables = describeConfig(env);
      const missing = variables
        .filter((variable) => variable.required && !variable.set)
        .map((variable) => variable.variable);
      const data = { envFiles, ready: missing.length === 0, variables, missing };

      // Required and optional are shown apart: an unset optional variable
      // with a working default is not a problem, and calling it "missing"
      // sends people hunting for something that is not wrong.
      const describe = (variable: (typeof variables)[number]): string => {
        const status = variable.set ? 'set     ' : variable.required ? 'MISSING ' : 'default ';
        const shown = variable.set
          ? variable.secret
            ? ' = ********'
            : ` = ${variable.value}`
          : variable.default !== undefined
            ? ` = ${variable.default}`
            : '';
        return `  ${status} ${variable.variable}${shown}`;
      };

      writeResult(context.writer, context.format, 'config', data, () => [
        envFiles.length > 0 ? `Env files: ${envFiles.join(', ')}` : 'Env files: none found',
        '',
        'Required:',
        ...variables.filter((variable) => variable.required).map(describe),
        '',
        'Optional:',
        ...variables.filter((variable) => !variable.required).map(describe),
        '',
        missing.length === 0
          ? 'Ready. Check the credentials for real with: open-nav token'
          : `Not ready: ${missing.join(', ')} still needed.`,
      ]);
      return missing.length === 0 ? EXIT.ok : EXIT.usage;
    },
  },

  {
    name: 'validate',
    summary: 'Validate an invoice XML file locally, without contacting NAV',
    usage:
      'open-nav validate <file.xml|-> [--operation CREATE|MODIFY|STORNO] [--language en|hu|de]',
    needsCredentials: false,
    options: [
      { flag: '--operation', description: 'Operation the document will be submitted under' },
      { flag: '--language', description: 'Language for NAV fault descriptions' },
      { flag: '--warnings-as-errors', description: 'Exit non-zero on warnings too' },
    ],
    async run(positionals, flags, context) {
      const path = requirePositional(positionals, 0, 'file');
      const xml = readInput(path, context);
      const parsed = parseDocument(xml, { unknownElements: 'ignore' });
      if (parsed.root !== 'InvoiceData') {
        throw new UsageError(`Expected an InvoiceData document, found ${parsed.root}`);
      }

      const operation = flags['operation'] ? String(flags['operation']).toUpperCase() : undefined;
      if (operation && !['CREATE', 'MODIFY', 'STORNO'].includes(operation)) {
        throw new UsageError('--operation must be CREATE, MODIFY or STORNO');
      }
      const language = flags['language'] ? String(flags['language']) : 'en';
      if (!['en', 'hu', 'de'].includes(language)) {
        throw new UsageError('--language must be en, hu or de');
      }

      const report = validateInvoice(parsed.value as InvoiceData, {
        ...(operation ? { operation: operation as 'CREATE' } : {}),
        language: language as 'en',
      });

      const strict = flags['warnings-as-errors'] === true;
      const data = {
        file: path,
        valid: report.valid,
        errorCount: report.errors.length,
        warningCount: report.warnings.length,
        issues: report.issues,
      };
      writeResult(context.writer, context.format, 'validate', data, () => [
        `${path}: ${report.valid ? 'valid' : 'invalid'} (${issueSummary(report.issues)})`,
        ...(report.issues.length > 0 ? ['', ...renderIssues(report.issues)] : []),
      ]);

      if (!report.valid) return EXIT.invalid;
      return strict && report.warnings.length > 0 ? EXIT.invalid : EXIT.ok;
    },
  },

  {
    name: 'fault',
    summary: "Look up NAV's description of a validation fault code",
    usage: 'open-nav fault <CODE> [--language en|hu|de]',
    needsCredentials: false,
    async run(positionals, flags, context) {
      const code = requirePositional(positionals, 0, 'code').toUpperCase();
      const language = (flags['language'] ? String(flags['language']) : 'en') as 'en';
      const message = faultMessage(code as 'SCHEMA_VIOLATION', language);
      if (!message) throw new UsageError(`No NAV description for fault code ${code}`);
      const data = { code, language, message };
      writeResult(context.writer, context.format, 'fault', data, () => [`${code}: ${message}`]);
      return EXIT.ok;
    },
  },

  {
    name: 'token',
    summary: 'Exchange credentials for a token — the quickest end-to-end check',
    usage: 'open-nav token',
    needsCredentials: true,
    async run(_positionals, _flags, context) {
      const result = await client(context).tokenExchange();
      const data = {
        tokenLength: result.token.length,
        validityFrom: result.validityFrom,
        validityTo: result.validityTo,
      };
      writeResult(context.writer, context.format, 'token', data, () => [
        'Credentials accepted, token decrypted.',
        ...renderFields([
          ['valid from', result.validityFrom],
          ['valid to', result.validityTo],
        ]),
      ]);
      return EXIT.ok;
    },
  },

  {
    name: 'taxpayer',
    summary: 'Look up a Hungarian taxpayer by tax number',
    usage: 'open-nav taxpayer <taxNumber>',
    needsCredentials: true,
    async run(positionals, _flags, context) {
      const input = requirePositional(positionals, 0, 'taxNumber');
      // Accept the written 11 digit form and use the core, which is what NAV wants.
      const { taxpayerId } = parseTaxNumber(input);
      const response = await client(context).queryTaxpayer({ taxNumber: taxpayerId });
      const data = {
        taxNumber: taxpayerId,
        valid: response.taxpayerValidity ?? false,
        taxpayer: response.taxpayerData,
      };
      writeResult(context.writer, context.format, 'taxpayer', data, () => [
        ...renderFields([
          ['tax number', taxpayerId],
          ['valid', String(data.valid)],
          ['name', response.taxpayerData?.taxpayerName],
          ['short name', response.taxpayerData?.taxpayerShortName],
        ]),
      ]);
      return data.valid ? EXIT.ok : EXIT.rejected;
    },
  },

  {
    name: 'submit',
    summary: 'Validate and submit invoice XML files',
    usage:
      'open-nav submit <file.xml...> [--operation CREATE] [--wait] [--compress] [--skip-validation]',
    needsCredentials: true,
    options: [
      { flag: '--operation', description: 'CREATE (default), MODIFY or STORNO' },
      { flag: '--wait', description: 'Poll until NAV reaches a verdict' },
      { flag: '--compress', description: 'Gzip the payloads' },
      { flag: '--skip-validation', description: 'Do not validate before sending' },
    ],
    async run(positionals, flags, context) {
      if (positionals.length === 0) throw new UsageError('Missing <file.xml>');
      const operationRaw = flags['operation'] ? String(flags['operation']).toUpperCase() : 'CREATE';
      if (!['CREATE', 'MODIFY', 'STORNO'].includes(operationRaw)) {
        throw new UsageError('--operation must be CREATE, MODIFY or STORNO');
      }
      const operation = operationRaw as 'CREATE';

      const invoices: InvoiceData[] = [];
      const validationIssues: Array<{ file: string; issues: InvoiceValidationIssue[] }> = [];
      for (const path of positionals) {
        const parsed = parseDocument(readInput(path, context), { unknownElements: 'ignore' });
        if (parsed.root !== 'InvoiceData') {
          throw new UsageError(`${path}: expected an InvoiceData document, found ${parsed.root}`);
        }
        const invoice = parsed.value as InvoiceData;
        invoices.push(invoice);

        // Validate before sending by default: a rejection costs a round trip
        // and burns the requestId, and NAV's messages are terser than ours.
        if (flags['skip-validation'] !== true) {
          const report = validateInvoice(invoice, { operation });
          if (report.issues.length > 0)
            validationIssues.push({ file: path, issues: report.issues });
        }
      }

      const blocking = validationIssues.filter((entry) =>
        entry.issues.some((issue) => issue.severity === 'error'),
      );
      if (blocking.length > 0) {
        writeResult(
          context.writer,
          context.format,
          'submit',
          { submitted: false, validation: validationIssues },
          () => [
            'Not submitted: local validation failed.',
            ...blocking.flatMap((entry) => [`${entry.file}:`, ...renderIssues(entry.issues)]),
          ],
        );
        return EXIT.invalid;
      }

      const response = await client(context).submitInvoices(
        invoices.map((invoice) => ({ operation, invoice })),
        { compress: flags['compress'] === true },
      );

      if (flags['wait'] !== true) {
        const data = {
          submitted: true,
          transactionId: response.transactionId,
          count: invoices.length,
          validation: validationIssues,
        };
        writeResult(context.writer, context.format, 'submit', data, () => [
          `Submitted ${invoices.length} invoice(s).`,
          ...renderFields([['transaction', response.transactionId]]),
          'Check the outcome with: open-nav status ' + response.transactionId,
        ]);
        return EXIT.ok;
      }

      const outcome = await waitForTransaction(client(context), response.transactionId);
      const data = {
        submitted: true,
        transactionId: response.transactionId,
        accepted: outcome.accepted.length,
        rejected: outcome.rejected.length,
        warnings: outcome.warnings.length,
        results: outcome.results,
        validation: validationIssues,
      };
      writeResult(context.writer, context.format, 'submit', data, () => [
        ...renderFields([
          ['transaction', response.transactionId],
          ['accepted', outcome.accepted.length],
          ['rejected', outcome.rejected.length],
          ['warnings', outcome.warnings.length],
        ]),
      ]);
      return outcome.rejected.length > 0 ? EXIT.rejected : EXIT.ok;
    },
  },

  {
    name: 'status',
    summary: 'Show the processing status of a submitted transaction',
    usage: 'open-nav status <transactionId> [--wait]',
    needsCredentials: true,
    options: [{ flag: '--wait', description: 'Poll until NAV reaches a verdict' }],
    async run(positionals, flags, context) {
      const transactionId = requirePositional(positionals, 0, 'transactionId');
      const navClient = client(context);

      if (flags['wait'] === true) {
        const outcome = await waitForTransaction(navClient, transactionId);
        const data = {
          transactionId,
          accepted: outcome.accepted.length,
          rejected: outcome.rejected.length,
          results: outcome.results,
        };
        writeResult(context.writer, context.format, 'status', data, () =>
          renderFields([
            ['transaction', transactionId],
            ['accepted', outcome.accepted.length],
            ['rejected', outcome.rejected.length],
          ]),
        );
        return outcome.rejected.length > 0 ? EXIT.rejected : EXIT.ok;
      }

      const response = await navClient.queryTransactionStatus({ transactionId });
      const results = response.processingResults?.processingResult ?? [];
      const data = { transactionId, results };
      writeResult(context.writer, context.format, 'status', data, () => [
        ...renderFields([
          ['transaction', transactionId],
          ['invoices', results.length],
        ]),
        ...results.map((result) => `  #${result.index}  ${result.invoiceStatus}`),
      ]);
      const pending = results.some(
        (result) => result.invoiceStatus !== 'DONE' && result.invoiceStatus !== 'ABORTED',
      );
      if (results.some((result) => result.invoiceStatus === 'ABORTED')) return EXIT.rejected;
      return pending || results.length === 0 ? EXIT.unavailable : EXIT.ok;
    },
  },

  {
    name: 'digest',
    summary: 'List invoices issued or received in a date range',
    usage:
      'open-nav digest --from YYYY-MM-DD --to YYYY-MM-DD [--direction outbound|inbound] [--page N]',
    needsCredentials: true,
    options: [
      { flag: '--from', description: 'First issue date, inclusive' },
      { flag: '--to', description: 'Last issue date, inclusive' },
      { flag: '--direction', description: 'outbound (default) or inbound' },
      { flag: '--page', description: 'Page number, from 1' },
    ],
    async run(_positionals, flags, context) {
      const from = flags['from'] ? String(flags['from']) : undefined;
      const to = flags['to'] ? String(flags['to']) : undefined;
      if (!from || !to) throw new UsageError('--from and --to are required (YYYY-MM-DD)');
      const page = flags['page'] ? Number(flags['page']) : 1;
      if (!Number.isInteger(page) || page < 1) throw new UsageError('--page must be 1 or more');

      const response = await client(context).queryInvoiceDigest({
        page,
        invoiceDirection: direction(flags),
        invoiceQueryParams: {
          mandatoryQueryParams: { invoiceIssueDate: { dateFrom: from, dateTo: to } },
        },
      });
      const digests = response.invoiceDigestResult.invoiceDigest ?? [];
      const data = {
        page: response.invoiceDigestResult.currentPage,
        availablePages: response.invoiceDigestResult.availablePage,
        count: digests.length,
        invoices: digests,
      };
      writeResult(context.writer, context.format, 'digest', data, () => [
        `Page ${data.page} of ${data.availablePages}, ${digests.length} invoice(s).`,
        ...digests.map(
          (digest) =>
            `  ${digest.invoiceNumber}  ${digest.invoiceIssueDate}  ` +
            `${digest.supplierTaxNumber}  ${digest.invoiceNetAmount ?? ''}`,
        ),
      ]);
      return EXIT.ok;
    },
  },

  {
    name: 'invoice',
    summary: 'Fetch one invoice in full and print its XML',
    usage: 'open-nav invoice <invoiceNumber> [--direction outbound|inbound] [--supplier TAXNUMBER]',
    needsCredentials: true,
    options: [
      { flag: '--direction', description: 'outbound (default) or inbound' },
      { flag: '--supplier', description: 'Supplier tax number, required for inbound invoices' },
      { flag: '--xml', description: 'Print the invoice XML rather than JSON' },
    ],
    async run(positionals, flags, context) {
      const invoiceNumber = requirePositional(positionals, 0, 'invoiceNumber');
      const requested = direction(flags);
      const supplier = flags['supplier'] ? String(flags['supplier']) : undefined;
      if (requested === 'INBOUND' && !supplier) {
        throw new UsageError('--supplier is required for an inbound invoice');
      }

      const response = await client(context).queryInvoiceData({
        invoiceNumberQuery: {
          invoiceNumber,
          invoiceDirection: requested,
          ...(supplier ? { supplierTaxNumber: parseTaxNumber(supplier).taxpayerId } : {}),
        },
      });

      const result = response.invoiceDataResult;
      if (!result) {
        writeResult(
          context.writer,
          context.format,
          'invoice',
          { found: false, invoiceNumber },
          () => [`No invoice found for ${invoiceNumber}.`],
        );
        return EXIT.rejected;
      }

      const { decodeInvoiceData } = await import('@open-nav/core');
      const invoice = decodeInvoiceData(result.invoiceData, {
        compressed: result.compressedContentIndicator,
      });

      if (flags['xml'] === true) {
        context.writer.out(serializeDocument('InvoiceData', invoice, { indent: '  ' }));
        return EXIT.ok;
      }

      const data = { found: true, invoiceNumber, auditData: result.auditData, invoice };
      writeResult(context.writer, context.format, 'invoice', data, () => [
        serializeDocument('InvoiceData', invoice, { indent: '  ' }),
      ]);
      return EXIT.ok;
    },
  },

  {
    name: 'render',
    summary: 'Render an invoice as a printable HTML document',
    usage: 'open-nav render <file.xml> [--out file.html] [--language hu|en] [--note text]',
    needsCredentials: false,
    options: [
      { flag: '--out', description: 'Write to this file instead of standard output' },
      { flag: '--language', description: 'hu (default) or en' },
      { flag: '--note', description: 'Extra note printed under the totals' },
    ],
    async run(positionals, flags, context) {
      const path = requirePositional(positionals, 0, 'file');
      const invoice = readInvoice(path, context);

      const language = flags['language'] ? String(flags['language']) : 'hu';
      if (language !== 'hu' && language !== 'en') {
        throw new UsageError('--language must be hu or en');
      }

      const html = renderInvoiceHtml(invoice, {
        language,
        ...(flags['note'] ? { note: String(flags['note']) } : {}),
      });

      const out = flags['out'] ? String(flags['out']) : undefined;
      if (!out) {
        // Straight to stdout, so it can be piped into a PDF converter.
        context.writer.out(html);
        return EXIT.ok;
      }

      writeOutput(out, html, context);
      const data = { file: path, out, bytes: html.length, language };
      writeResult(context.writer, context.format, 'render', data, () => [
        `Wrote ${out} (${html.length} bytes).`,
        'To PDF:  chromium --headless --print-to-pdf=invoice.pdf ' + out,
      ]);
      return EXIT.ok;
    },
  },

  {
    name: 'export',
    summary: 'Produce the tax authority data export for a set of invoices',
    usage:
      'open-nav export <file.xml...> --out <dir> [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--number-from N] [--number-to N]',
    needsCredentials: false,
    options: [
      { flag: '--out', description: 'Directory to write the export into (required)' },
      { flag: '--from', description: 'First issue date to include' },
      { flag: '--to', description: 'Last issue date to include' },
      { flag: '--number-from', description: 'First invoice number to include' },
      { flag: '--number-to', description: 'Last invoice number to include' },
    ],
    async run(positionals, flags, context) {
      if (positionals.length === 0) throw new UsageError('Missing <file.xml>');
      const out = flags['out'] ? String(flags['out']) : undefined;
      if (!out) throw new UsageError('--out <dir> is required');

      const invoices = positionals.map((path) => readInvoice(path, context));
      const result = createDataExport(invoices, {
        ...(flags['from'] ? { issueDateFrom: String(flags['from']) } : {}),
        ...(flags['to'] ? { issueDateTo: String(flags['to']) } : {}),
        ...(flags['number-from'] ? { invoiceNumberFrom: String(flags['number-from']) } : {}),
        ...(flags['number-to'] ? { invoiceNumberTo: String(flags['number-to']) } : {}),
      });

      for (const file of result.files) {
        writeOutput(join(out, file.name), file.contents, context);
      }

      const data = {
        out,
        considered: invoices.length,
        exported: result.manifest.invoiceCount,
        files: result.files.map((file) => file.name),
        structure: result.manifest.structure,
      };
      writeResult(context.writer, context.format, 'export', data, () => [
        `Exported ${result.manifest.invoiceCount} of ${invoices.length} invoice(s) to ${out}.`,
        `Structure: ${result.manifest.structure.schema}`,
        `Basis: ${result.manifest.structure.basis}`,
      ]);
      return EXIT.ok;
    },
  },

  {
    name: 'transactions',
    summary: 'List data submissions made in a time range',
    usage: 'open-nav transactions --from <ISO datetime> --to <ISO datetime> [--page N]',
    needsCredentials: true,
    options: [
      { flag: '--from', description: 'Start of the window, as an ISO timestamp' },
      { flag: '--to', description: 'End of the window, as an ISO timestamp' },
      { flag: '--page', description: 'Page number, from 1' },
    ],
    async run(_positionals, flags, context) {
      const from = flags['from'] ? String(flags['from']) : undefined;
      const to = flags['to'] ? String(flags['to']) : undefined;
      if (!from || !to) throw new UsageError('--from and --to are required (ISO timestamps)');
      const page = flags['page'] ? Number(flags['page']) : 1;

      const response = await client(context).queryTransactionList({
        page,
        insDate: { dateTimeFrom: from, dateTimeTo: to },
      });
      const transactions = response.transactionListResult.transaction ?? [];
      const data = {
        page: response.transactionListResult.currentPage,
        availablePages: response.transactionListResult.availablePage,
        transactions,
      };
      writeResult(context.writer, context.format, 'transactions', data, () => [
        `Page ${data.page} of ${data.availablePages}, ${transactions.length} transaction(s).`,
        ...transactions.map(
          (transaction) =>
            `  ${transaction.transactionId}  ${transaction.insDate}  ${transaction.requestStatus ?? ''}`,
        ),
      ]);
      return EXIT.ok;
    },
  },
];

export function findCommand(name: string): CommandDefinition | undefined {
  return COMMANDS.find((command) => command.name === name);
}

/** Machine-readable description of the whole surface, for tooling and agents. */
export function describeCommands(): unknown {
  return {
    name: 'open-nav',
    description: 'Command line access to the NAV Online Számla 3.0 invoice service',
    exitCodes: EXIT,
    configuration: 'Set NAV_* environment variables, or put them in a .env file.',
    commands: COMMANDS.map((command) => ({
      name: command.name,
      summary: command.summary,
      usage: command.usage,
      needsCredentials: command.needsCredentials,
      options: command.options ?? [],
    })),
  };
}

export { NavApiError };
