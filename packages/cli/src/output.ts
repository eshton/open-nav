import type { InvoiceValidationIssue } from '@open-nav/core';

/**
 * Output format.
 *
 * JSON is the default whenever output is not a terminal, so a program or an
 * agent calling this tool always gets something parseable without having to
 * remember a flag. A human at a terminal gets readable text.
 */
export type Format = 'json' | 'text';

export function resolveFormat(explicit: Format | undefined, isTty: boolean): Format {
  return explicit ?? (isTty ? 'text' : 'json');
}

export interface Writer {
  out: (line: string) => void;
  err: (line: string) => void;
}

export const consoleWriter: Writer = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
};

/** Envelope every JSON result shares, so callers can branch on `ok` alone. */
export interface ResultEnvelope {
  ok: boolean;
  command: string;
  data?: unknown;
  error?: { message: string; code?: string; details?: unknown };
}

export function writeResult(
  writer: Writer,
  format: Format,
  command: string,
  data: unknown,
  renderText: (data: never) => string[],
): void {
  if (format === 'json') {
    const envelope: ResultEnvelope = { ok: true, command, data };
    writer.out(JSON.stringify(envelope, null, 2));
    return;
  }
  for (const line of renderText(data as never)) writer.out(line);
}

export function writeError(
  writer: Writer,
  format: Format,
  command: string,
  error: { message: string; code?: string; details?: unknown },
): void {
  if (format === 'json') {
    const envelope: ResultEnvelope = { ok: false, command, error };
    writer.out(JSON.stringify(envelope, null, 2));
    return;
  }
  writer.err(error.code ? `${error.code}: ${error.message}` : error.message);
  if (error.details !== undefined) {
    writer.err(
      typeof error.details === 'string' ? error.details : JSON.stringify(error.details, null, 2),
    );
  }
}

/** Render validation issues as aligned text. */
export function renderIssues(issues: InvoiceValidationIssue[]): string[] {
  return issues.map((issue) => {
    const marker = issue.severity === 'error' ? 'error' : 'warn ';
    const nav = issue.navMessage ? `\n         NAV: ${issue.navMessage}` : '';
    return `  ${marker}  ${issue.code}\n         ${issue.path}\n         ${issue.message}${nav}`;
  });
}

/** A compact `key: value` block. */
export function renderFields(
  fields: Array<[string, string | number | boolean | undefined]>,
): string[] {
  const width = Math.max(...fields.map(([label]) => label.length));
  return fields
    .filter(([, value]) => value !== undefined)
    .map(([label, value]) => `  ${label.padEnd(width)}  ${String(value)}`);
}
