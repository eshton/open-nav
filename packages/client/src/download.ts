import {
  QUERY_PAGE_SIZE,
  decodeInvoiceData,
  serializeDocument,
  type InvoiceDataResultType,
  type InvoiceData,
  type InvoiceDigestType,
  type InvoiceDirectionType,
} from '@open-nav/core';
import type { NavClient } from './client.js';

/**
 * Bulk retrieval of invoices from NAV.
 *
 * Two things make this more than a loop. NAV caps a digest query at **35
 * days** — `BAD_QUERY_PARAM_RANGE_EXCEEDED`, "Date interval defined by the
 * query parameters must not exceed 35 days" — so any useful range has to be
 * split. And an inbound invoice must be fetched with the supplier's tax
 * number, which is only knowable from the digest entry that named it.
 */

/** Longest interval NAV accepts in one digest query. */
export const MAX_QUERY_DAYS = 35;

export interface DownloadOptions {
  /** `INBOUND` for invoices issued to you, `OUTBOUND` for your own. */
  direction?: InvoiceDirectionType;
  /** First issue date, inclusive, as `yyyy-mm-dd`. */
  dateFrom: string;
  /** Last issue date, inclusive, as `yyyy-mm-dd`. */
  dateTo: string;
  /**
   * Pause between requests, in milliseconds. Defaults to 250.
   *
   * NAV rate limits per taxpayer, and a download makes one request per
   * invoice. Pacing is cheaper than being throttled.
   */
  delayMs?: number;
  /** Called before each invoice is fetched, for progress reporting. */
  onProgress?: (progress: DownloadProgress) => void;
  /** Injectable sleep, for tests. */
  sleep?: (ms: number) => Promise<void>;
}

export interface DownloadProgress {
  /** The window currently being queried. */
  window: DateWindow;
  windowIndex: number;
  windowCount: number;
  /** Digest entries seen so far, across all windows. */
  seen: number;
  /** Invoices fetched so far. */
  fetched: number;
}

export interface DateWindow {
  dateFrom: string;
  dateTo: string;
}

export interface DownloadedInvoice {
  /** The digest entry that led to this invoice. */
  digest: InvoiceDigestType;
  /** The decoded invoice. */
  invoice: InvoiceData;
  /** The invoice re-serialised, for writing to disk. */
  xml: string;
  /** NAV's own record of when and how the data arrived. */
  auditData: InvoiceDataResultType['auditData'];
}

/**
 * Split a date range into windows NAV will accept.
 *
 * Inclusive at both ends, so a 35 day window spans `dateFrom` to
 * `dateFrom + 34 days`: NAV compares the two dates given, and 35 days apart
 * is already over the line.
 */
export function chunkDateRange(
  dateFrom: string,
  dateTo: string,
  maxDays = MAX_QUERY_DAYS,
): DateWindow[] {
  const start = parseDate(dateFrom, 'dateFrom');
  const end = parseDate(dateTo, 'dateTo');
  if (start > end) {
    throw new RangeError(`dateFrom ${dateFrom} is after dateTo ${dateTo}`);
  }

  const windows: DateWindow[] = [];
  const dayMs = 86_400_000;
  for (let cursor = start; cursor <= end; cursor += maxDays * dayMs) {
    const windowEnd = Math.min(cursor + (maxDays - 1) * dayMs, end);
    windows.push({ dateFrom: formatDate(cursor), dateTo: formatDate(windowEnd) });
  }
  return windows;
}

function parseDate(value: string, field: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new RangeError(`${field} must be yyyy-mm-dd, got ${JSON.stringify(value)}`);
  }
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(timestamp)) throw new RangeError(`${field} is not a real date: ${value}`);
  return timestamp;
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

/**
 * Walk every digest entry in a date range, across windows and pages.
 *
 * A digest is a summary. It is enough to decide what to fetch, and cheap:
 * one request per hundred invoices.
 */
export async function* iterateInvoiceDigests(
  client: NavClient,
  options: DownloadOptions,
): AsyncGenerator<{ digest: InvoiceDigestType; window: DateWindow }> {
  const direction = options.direction ?? 'INBOUND';
  const windows = chunkDateRange(options.dateFrom, options.dateTo);
  const pause = pauser(options);
  let seen = 0;

  for (const [windowIndex, window] of windows.entries()) {
    let page = 1;
    let availablePage = 1;

    do {
      if (seen > 0 || page > 1) await pause();
      const response = await client.queryInvoiceDigest({
        page,
        invoiceDirection: direction,
        invoiceQueryParams: {
          mandatoryQueryParams: {
            invoiceIssueDate: { dateFrom: window.dateFrom, dateTo: window.dateTo },
          },
        },
      });

      const result = response.invoiceDigestResult;
      availablePage = result.availablePage;
      const entries = result.invoiceDigest ?? [];

      for (const digest of entries) {
        seen += 1;
        options.onProgress?.({
          window,
          windowIndex,
          windowCount: windows.length,
          seen,
          fetched: 0,
        });
        yield { digest, window };
      }

      // NAV reports 0 available pages for an empty result.
      if (entries.length < QUERY_PAGE_SIZE) break;
      page += 1;
    } while (page <= availablePage);
  }
}

/**
 * Walk every invoice in a date range, fetching each in full.
 *
 * One request per invoice, so this is the expensive one; pace it with
 * `delayMs` and consider whether the digest alone answers your question.
 */
export async function* iterateInvoices(
  client: NavClient,
  options: DownloadOptions,
): AsyncGenerator<DownloadedInvoice> {
  const direction = options.direction ?? 'INBOUND';
  const pause = pauser(options);
  let fetched = 0;
  let seen = 0;

  for await (const { digest, window } of iterateInvoiceDigests(client, {
    ...options,
    // Progress is reported here instead, where the counts are complete.
    ...(options.onProgress ? { onProgress: undefined } : {}),
  })) {
    seen += 1;
    await pause();

    const response = await client.queryInvoiceData({
      invoiceNumberQuery: {
        invoiceNumber: digest.invoiceNumber,
        invoiceDirection: direction,
        // Only meaningful when querying as the customer: NAV answers
        // BAD_QUERY_PARAM_SUPPLIER_NOT_EXPECTED if it is sent otherwise.
        ...(direction === 'INBOUND' ? { supplierTaxNumber: digest.supplierTaxNumber } : {}),
        ...(digest.batchIndex !== undefined ? { batchIndex: digest.batchIndex } : {}),
      },
    });

    const result = response.invoiceDataResult;
    if (!result) continue; // Listed in the digest but no longer retrievable.

    const invoice = decodeInvoiceData(result.invoiceData, {
      compressed: result.compressedContentIndicator,
    });
    fetched += 1;
    options.onProgress?.({
      window,
      windowIndex: 0,
      windowCount: 0,
      seen,
      fetched,
    });

    yield {
      digest,
      invoice,
      xml: serializeDocument('InvoiceData', invoice, { indent: '  ' }),
      auditData: result.auditData,
    };
  }
}

/** Collect a whole range into memory. Convenient, but unbounded. */
export async function downloadInvoices(
  client: NavClient,
  options: DownloadOptions,
): Promise<DownloadedInvoice[]> {
  const collected: DownloadedInvoice[] = [];
  for await (const entry of iterateInvoices(client, options)) collected.push(entry);
  return collected;
}

function pauser(options: DownloadOptions): () => Promise<void> {
  const delayMs = options.delayMs ?? 250;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  return () => (delayMs > 0 ? sleep(delayMs) : Promise.resolve());
}
