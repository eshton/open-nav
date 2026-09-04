import type { InvoiceData, InvoiceStatusType } from '@open-nav/core';

/**
 * Everything the mock service remembers.
 *
 * Held in memory and exposed on the server handle, so a test can assert on
 * what was actually received rather than only on what came back.
 */
export interface MockState {
  /** Invoices accepted, keyed by invoice number. */
  invoices: Map<string, StoredInvoice>;
  /** Invoices issued *to* this taxpayer, seeded by the test. */
  inbound: Map<string, StoredInvoice>;
  /** Transactions, keyed by transaction id. */
  transactions: Map<string, StoredTransaction>;
  /** Every `requestId` seen, since NAV rejects a replayed one. */
  requestIds: Set<string>;
  /** Exchange tokens issued and not yet spent. */
  tokens: Map<string, { issuedAt: number; spent: boolean }>;
  /** Taxpayers the mock knows about, keyed by 8 digit core tax number. */
  taxpayers: Map<string, MockTaxpayer>;
  /** Requests received, newest last, for assertions. */
  requests: Array<{ operation: string; requestId: string; body: string }>;
}

export interface StoredInvoice {
  invoiceNumber: string;
  /** `CREATE`, `MODIFY` or `STORNO`. */
  operation: string;
  supplierTaxNumber: string;
  customerTaxNumber?: string;
  issueDate: string;
  /** The payload exactly as submitted, still base64. */
  base64: string;
  compressed: boolean;
  invoice: InvoiceData;
  transactionId: string;
  index: number;
  insDate: string;
}

export interface StoredTransaction {
  transactionId: string;
  insDate: string;
  /** Poll count, used to simulate asynchronous processing. */
  polls: number;
  results: Array<{
    index: number;
    invoiceStatus: InvoiceStatusType;
    /** Findings, mirroring NAV's split between technical and business faults. */
    businessValidationMessages: Array<{
      validationResultCode: 'ERROR' | 'WARN' | 'INFO';
      validationErrorCode?: string;
      message?: string;
    }>;
  }>;
  /** Status the results settle on once processing finishes. */
  finalStatuses: InvoiceStatusType[];
}

export interface MockTaxpayer {
  taxNumber: string;
  name: string;
  shortName?: string;
  valid: boolean;
  vatCode?: string;
  countyCode?: string;
}

export function createState(taxpayers: MockTaxpayer[] = []): MockState {
  return {
    invoices: new Map(),
    inbound: new Map(),
    transactions: new Map(),
    requestIds: new Set(),
    tokens: new Map(),
    taxpayers: new Map(taxpayers.map((taxpayer) => [taxpayer.taxNumber, taxpayer])),
    requests: [],
  };
}
