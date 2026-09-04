import { createHash } from 'node:crypto';
import { serializeDocument, type InvoiceData } from '@open-nav/core';

/**
 * The data export an invoicing program must be able to produce.
 *
 * Decree 23/2014. (VI. 30.) NGM requires every invoicing program to have a
 * built-in "adóhatósági ellenőrzési adatszolgáltatás" function that exports
 * the invoices issued in a given date range, or in a given invoice number
 * range, as XML.
 *
 * Two structures are permitted. Annexes 2 and 3 of the decree define one
 * (`szamla.xsd`); section 13/A(1) permits the other — the structure published
 * for the online invoice data service, which is `invoiceData.xsd`. This
 * implementation produces the second, because it is the same schema this
 * project already generates, validates and round-trips against NAV's own
 * sample documents.
 *
 * That choice belongs to the taxpayer, not to this library. If your auditor
 * asks for the Annex 3 structure specifically, this export is not it.
 */

export interface DataExportSelection {
  /** First issue date to include, inclusive, as `yyyy-mm-dd`. */
  issueDateFrom?: string;
  /** Last issue date to include, inclusive. */
  issueDateTo?: string;
  /** First invoice number to include, inclusive. */
  invoiceNumberFrom?: string;
  /** Last invoice number to include, inclusive. */
  invoiceNumberTo?: string;
}

export interface DataExportOptions extends DataExportSelection {
  /**
   * How invoice numbers are ordered when a number range is given.
   *
   * The default compares digit runs numerically, so `2024/9` sorts before
   * `2024/10`. Plain text ordering puts them the other way round and would
   * silently drop invoices from the middle of a requested range — which is
   * the kind of mistake an audit is precisely designed to find.
   */
  compareInvoiceNumbers?: (left: string, right: string) => number;
  /** Injectable clock, so an export is reproducible in tests. */
  now?: () => Date;
}

export interface ExportedFile {
  /** Path within the export, e.g. `invoices/2024-000123.xml`. */
  name: string;
  contents: string;
}

export interface ExportedInvoice {
  invoiceNumber: string;
  invoiceIssueDate: string;
  file: string;
  /** SHA-256 of the file, so the export can be shown to be unaltered. */
  sha256: string;
}

export interface DataExportManifest {
  /** What was asked for. */
  selection: DataExportSelection;
  /** The structure used, and the provision that permits it. */
  structure: {
    schema: string;
    namespace: string;
    basis: string;
  };
  generatedAt: string;
  invoiceCount: number;
  invoices: ExportedInvoice[];
}

export interface DataExportResult {
  /** Every file in the export, manifest included. */
  files: ExportedFile[];
  manifest: DataExportManifest;
}

/**
 * Natural ordering for invoice numbers: digit runs compare as numbers.
 *
 * `2024/9` before `2024/10`, and `A-2` before `A-10`.
 */
export function compareInvoiceNumbersNaturally(left: string, right: string): number {
  const chunk = /(\d+|\D+)/g;
  const leftParts = left.match(chunk) ?? [];
  const rightParts = right.match(chunk) ?? [];

  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const a = leftParts[index];
    const b = rightParts[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;

    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) {
      // BigInt, because an invoice number can be longer than a safe integer.
      const difference = BigInt(a) - BigInt(b);
      if (difference !== 0n) return difference < 0n ? -1 : 1;
      continue;
    }
    if (a !== b) return a < b ? -1 : 1;
  }
  return 0;
}

/** Whether an invoice falls inside the requested selection. */
export function isSelected(invoice: InvoiceData, options: DataExportOptions): boolean {
  const compare = options.compareInvoiceNumbers ?? compareInvoiceNumbersNaturally;

  if (options.issueDateFrom && invoice.invoiceIssueDate < options.issueDateFrom) return false;
  if (options.issueDateTo && invoice.invoiceIssueDate > options.issueDateTo) return false;
  if (options.invoiceNumberFrom && compare(invoice.invoiceNumber, options.invoiceNumberFrom) < 0) {
    return false;
  }
  if (options.invoiceNumberTo && compare(invoice.invoiceNumber, options.invoiceNumberTo) > 0) {
    return false;
  }
  return true;
}

/**
 * Build the export from a set of invoices.
 *
 * One XML file per invoice, plus a manifest recording what was selected and
 * the SHA-256 of every file, so the export can later be shown to be the one
 * that was produced.
 */
export function createDataExport(
  invoices: InvoiceData[],
  options: DataExportOptions = {},
): DataExportResult {
  const now = options.now ?? (() => new Date());
  const compare = options.compareInvoiceNumbers ?? compareInvoiceNumbersNaturally;

  const selected = invoices
    .filter((invoice) => isSelected(invoice, options))
    .sort((left, right) => compare(left.invoiceNumber, right.invoiceNumber));

  const files: ExportedFile[] = [];
  const entries: ExportedInvoice[] = [];
  const usedNames = new Set<string>();

  for (const invoice of selected) {
    const name = uniqueName(`invoices/${safeFileName(invoice.invoiceNumber)}.xml`, usedNames);
    const contents = serializeDocument('InvoiceData', invoice, { indent: '  ' });
    files.push({ name, contents });
    entries.push({
      invoiceNumber: invoice.invoiceNumber,
      invoiceIssueDate: invoice.invoiceIssueDate,
      file: name,
      sha256: createHash('sha256').update(contents, 'utf8').digest('hex'),
    });
  }

  const selection: DataExportSelection = {
    ...(options.issueDateFrom ? { issueDateFrom: options.issueDateFrom } : {}),
    ...(options.issueDateTo ? { issueDateTo: options.issueDateTo } : {}),
    ...(options.invoiceNumberFrom ? { invoiceNumberFrom: options.invoiceNumberFrom } : {}),
    ...(options.invoiceNumberTo ? { invoiceNumberTo: options.invoiceNumberTo } : {}),
  };

  const manifest: DataExportManifest = {
    selection,
    structure: {
      schema: 'invoiceData.xsd',
      namespace: 'http://schemas.nav.gov.hu/OSA/3.0/data',
      basis:
        '23/2014. (VI. 30.) NGM rendelet 13/A. § (1) — the data structure published ' +
        'for the online invoice data service',
    },
    generatedAt: now().toISOString(),
    invoiceCount: entries.length,
    invoices: entries,
  };

  files.push({ name: 'manifest.json', contents: `${JSON.stringify(manifest, null, 2)}\n` });
  return { files, manifest };
}

/** An invoice number can contain `/`, which a file name cannot. */
function safeFileName(invoiceNumber: string): string {
  const cleaned = invoiceNumber.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned === '' ? 'invoice' : cleaned;
}

/** Two invoice numbers can sanitise to the same name; keep them distinct. */
function uniqueName(name: string, used: Set<string>): string {
  if (!used.has(name)) {
    used.add(name);
    return name;
  }
  for (let suffix = 2; ; suffix += 1) {
    const candidate = name.replace(/\.xml$/, `-${suffix}.xml`);
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
}
