import type { InvoiceCategoryType } from '@open-nav/core';
import type { DocumentLanguage } from './format.js';
import { documentTitle, label } from './labels.js';

/**
 * The kind of document to render from the invoice data.
 *
 * Only `invoice` is a tax invoice reported to NAV. The others are printable
 * business documents rendered from the same data but reported nowhere through
 * Online Számla:
 *
 * - `proforma` — díjbekérő, a request for payment. Looks like an invoice but is
 *   not one and carries no VAT deduction right.
 * - `deliveryNote` — szállítólevél, a list of goods delivered. No prices.
 * - `receipt` — nyugta, a simplified proof of payment showing the gross total.
 *   A nyugta's own *data reporting* (where required) goes through NAV's online
 *   cash-register system, not Online Számla — out of scope here; this only
 *   renders the printable document.
 */
export type DocumentType = 'invoice' | 'proforma' | 'deliveryNote' | 'receipt';

/** How much of the money detail a document type shows. */
export type MoneyDetail = 'full' | 'grossOnly' | 'none';

export interface DocumentDisplay {
  /** Line-level money columns (unit price, net, VAT rate/amount, gross). */
  lineMoney: MoneyDetail;
  /** The totals block. */
  totals: MoneyDetail;
  /** The per-rate VAT breakdown. */
  vatSummary: boolean;
  /** Statutory (VAT Act) markings — only meaningful on a real invoice. */
  markings: boolean;
  /** Whether the "rendered from data reported to NAV" note may appear. */
  provenance: boolean;
  /** Legal disclaimer shown on a non-tax document, or none. */
  disclaimerKey?: string;
}

const DISPLAY: Record<DocumentType, DocumentDisplay> = {
  invoice: {
    lineMoney: 'full',
    totals: 'full',
    vatSummary: true,
    markings: true,
    provenance: true,
  },
  proforma: {
    lineMoney: 'full',
    totals: 'full',
    vatSummary: true,
    markings: false,
    provenance: false,
    disclaimerKey: 'notTaxInvoice',
  },
  deliveryNote: {
    lineMoney: 'none',
    totals: 'none',
    vatSummary: false,
    markings: false,
    provenance: false,
    disclaimerKey: 'notTaxInvoice',
  },
  receipt: {
    lineMoney: 'grossOnly',
    totals: 'grossOnly',
    vatSummary: false,
    markings: false,
    provenance: false,
    disclaimerKey: 'notTaxInvoice',
  },
};

/** Display rules for a document type (defaults to the tax invoice). */
export function documentDisplay(type: DocumentType = 'invoice'): DocumentDisplay {
  return DISPLAY[type];
}

/** The document's printed heading. */
export function documentHeading(
  type: DocumentType,
  category: InvoiceCategoryType | undefined,
  isModification: boolean,
  language: DocumentLanguage,
): string {
  switch (type) {
    case 'proforma':
      return label('proforma', language);
    case 'deliveryNote':
      return label('deliveryNote', language);
    case 'receipt':
      return label('receipt', language);
    default:
      return documentTitle(category, isModification, language);
  }
}

/** The line columns a money detail level shows, in order. */
export type LineColumn =
  | 'lineNumber'
  | 'description'
  | 'quantity'
  | 'unit'
  | 'unitPrice'
  | 'net'
  | 'vatRate'
  | 'vatAmount'
  | 'gross';

const ALL_COLUMNS: LineColumn[] = [
  'lineNumber',
  'description',
  'quantity',
  'unit',
  'unitPrice',
  'net',
  'vatRate',
  'vatAmount',
  'gross',
];

/** Which line columns to render for a money detail level. */
export function lineColumns(money: MoneyDetail): LineColumn[] {
  if (money === 'none') return ['lineNumber', 'description', 'quantity', 'unit'];
  if (money === 'grossOnly') return ['lineNumber', 'description', 'quantity', 'unit', 'gross'];
  return ALL_COLUMNS;
}
