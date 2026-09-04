import type { InvoiceData } from '../generated/types.js';
import { IssueCollector, type MessageLanguage, type ValidationReport } from './issue.js';
import { collectSchemaIssues } from './schema.js';
import { collectBusinessIssues, type InvoiceValidationContext } from './rules.js';

export interface ValidateInvoiceOptions extends InvoiceValidationContext {
  /** Language for NAV's own fault descriptions. Defaults to English. */
  language?: MessageLanguage;
  /** Skip the business rules and check only the schema. */
  schemaOnly?: boolean;
}

/**
 * Check an invoice data report before sending it.
 *
 * Two layers run: the schema, derived from NAV's XSDs, and the business rules
 * that are decidable from the document alone. Every finding carries NAV's own
 * fault code where one exists, so a failure here reads the same as the
 * rejection it prevents.
 *
 * Warnings do not make a report invalid. The distinction matters: a tax number
 * whose check digit is wrong is worth flagging, but NAV validates tax numbers
 * against its registry, so treating it as an error would reject documents the
 * service accepts.
 *
 * ```ts
 * const report = validateInvoice(invoice, { operation: 'CREATE' });
 * if (!report.valid) console.error(report.errors);
 * ```
 */
export function validateInvoice(
  document: InvoiceData,
  options: ValidateInvoiceOptions = {},
): ValidationReport {
  const collector = new IssueCollector(options.language ?? 'en');
  collectSchemaIssues('InvoiceData', document, collector);

  const report = collector.report();
  // Business rules read the document as typed data; running them over a
  // structurally invalid document would produce noise, not findings.
  if (options.schemaOnly || report.errors.length > 0) return report;

  collectBusinessIssues(document, collector, options);
  return collector.report();
}
