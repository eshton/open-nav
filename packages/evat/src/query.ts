import type { EvatClient } from './client.js';
import { decodeDownloadPayload } from './transport.js';
import type { AnalyticsListItemType, DocumentListType } from './generated/types.js';

/**
 * Helpers for the eÁFA read queries whose window NAV caps at 35 days.
 *
 * `queryDeclarationList` / `queryDocumentList` reject a range longer than 35
 * days (BAD_QUERY_PARAM_RANGE_EXCEEDED). {@link chunkTaxpointRange} splits an
 * arbitrary range into legal windows and {@link queryAllDeclarations} walks them
 * so "give me the whole year" is one call, not a loop the caller re-invents.
 */

/** NAV's maximum query window, in days (inclusive of both ends). */
export const MAX_QUERY_DAYS = 35;

export interface TaxpointWindow {
  taxpointDateFrom: string;
  taxpointDateTo: string;
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
 * Split a taxpoint-date range into windows NAV accepts.
 *
 * Inclusive at both ends: a 35-day window spans `from` to `from + 34 days`,
 * because NAV compares the two dates given and 35 days apart is already over.
 */
export function chunkTaxpointRange(
  from: string,
  to: string,
  maxDays = MAX_QUERY_DAYS,
): TaxpointWindow[] {
  const start = parseDate(from, 'taxpointDateFrom');
  const end = parseDate(to, 'taxpointDateTo');
  if (start > end) throw new RangeError(`taxpointDateFrom ${from} is after taxpointDateTo ${to}`);

  const windows: TaxpointWindow[] = [];
  const dayMs = 86_400_000;
  for (let cursor = start; cursor <= end; cursor += maxDays * dayMs) {
    const windowEnd = Math.min(cursor + (maxDays - 1) * dayMs, end);
    windows.push({ taxpointDateFrom: formatDate(cursor), taxpointDateTo: formatDate(windowEnd) });
  }
  return windows;
}

/**
 * List every declaration in a taxpoint-date range, across the 35-day windows.
 *
 * Returns the flattened `declarationListItem`s from each window's response.
 */
export async function queryAllDeclarations(
  client: EvatClient,
  range: TaxpointWindow,
): Promise<AnalyticsListItemType[]> {
  const items: AnalyticsListItemType[] = [];
  for (const window of chunkTaxpointRange(range.taxpointDateFrom, range.taxpointDateTo)) {
    const response = await client.queryDeclarationList(window);
    items.push(...(response.declarationList?.declarationListItem ?? []));
  }
  return items;
}

/**
 * List every **statement** (bevallás) in a taxpoint-date range.
 *
 * `queryDeclarationList` returns two lists: `declarationList`, the
 * analytics-based M2M declarations, and `statementList`, the traditional VAT
 * returns (bevallás) — e.g. the monthly returns filed through ÖNYA/ÁNYK.
 * {@link queryAllDeclarations} flattens the former; this flattens the latter. If
 * a query "returns nothing", check both: a taxpayer's regular monthly returns
 * are statements, not declarations.
 */
export async function queryAllStatements(
  client: EvatClient,
  range: TaxpointWindow,
): Promise<AnalyticsListItemType[]> {
  const items: AnalyticsListItemType[] = [];
  for (const window of chunkTaxpointRange(range.taxpointDateFrom, range.taxpointDateTo)) {
    const response = await client.queryDeclarationList(window);
    items.push(...(response.statementList?.statementListItem ?? []));
  }
  return items;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface ResolveOptions {
  /** Polls before giving up on a still-PROCESSING result. Default 10. */
  maxAttempts?: number;
  /** Delay between polls, ms. Default 2000. */
  intervalMs?: number;
}

/**
 * Run a document-list query and resolve its asynchronous result.
 *
 * `queryDocumentList` returns a `queryId`; the result is fetched separately with
 * `queryDocumentListResult` and may still be `PROCESSING`. This does both and
 * polls until the result is `DONE` (or the attempts run out).
 */
export async function resolveDocumentList(
  client: EvatClient,
  window: TaxpointWindow,
  options: ResolveOptions = {},
): Promise<DocumentListType> {
  const maxAttempts = options.maxAttempts ?? 10;
  const intervalMs = options.intervalMs ?? 2000;
  const { queryId } = await client.queryDocumentList(window);
  for (let attempt = 0; ; attempt++) {
    const result = await client.queryDocumentListResult(queryId);
    const list = result.documentList;
    if (list?.queryResultStatus === 'DONE' || attempt >= maxAttempts - 1) {
      return list ?? ({ queryResultStatus: 'PROCESSING' } as DocumentListType);
    }
    await sleep(intervalMs);
  }
}

/**
 * Resolve the document list across every 35-day window in a range.
 *
 * Returns one {@link DocumentListType} per window (each carries its
 * `invoiceDigest` / `cashRegisterDigest` / `declarationDigest` arrays).
 */
export async function queryAllDocuments(
  client: EvatClient,
  range: TaxpointWindow,
  options: ResolveOptions = {},
): Promise<DocumentListType[]> {
  const lists: DocumentListType[] = [];
  for (const window of chunkTaxpointRange(range.taxpointDateFrom, range.taxpointDateTo)) {
    lists.push(await resolveDocumentList(client, window, options));
  }
  return lists;
}

/**
 * Read a filed return's compiled data in one call: download NAV's compiled
 * VAT-return payload and decode it to the `VatDeclarationData` XML.
 */
export async function readVatDeclaration(
  client: EvatClient,
  declarationProcessingId: string,
): Promise<string> {
  const download = await client.queryVatDeclarationData(declarationProcessingId);
  if (!download.payload) {
    throw new Error(
      `queryVatDeclarationData returned no payload for ${declarationProcessingId} ` +
        `(funcCode ${(download.value as { result?: { funcCode?: string } })?.result?.funcCode})`,
    );
  }
  return decodeDownloadPayload(download.payload);
}

export interface VatReturnSummary {
  processingId: string;
  schema: string;
  taxNumber: string | null;
  /** Declaration/statement period, `yyyy-mm-dd`. */
  periodStart: string | null;
  periodEnd: string | null;
  /** `true` = traditional return (statementInfo); `false` = analytics declaration. */
  isStatement: boolean;
  /** Only on analytics declarations. */
  declarationType: string | null;
  /** BASE | SELF_CHECK | CORRECTION. */
  method: string | null;
  /** e.g. MONTHLY | QUARTERLY | YEARLY. */
  frequency: string | null;
  version: number | null;
}

/**
 * Normalise one list item into a {@link VatReturnSummary}.
 *
 * A list item carries either `declarationInfo` (an analytics M2M declaration) or
 * `statementInfo` (a traditional return / bevallás, e.g. filed via ÖNYA/ÁNYK).
 * The two shapes name the same facts differently; this flattens both to one row.
 */
export function summariseDeclaration(item: AnalyticsListItemType): VatReturnSummary {
  const declaration = item.declarationInfo;
  const statement = item.statementInfo;
  return {
    processingId: item.declarationProcessingId,
    schema: item.declarationSchema,
    taxNumber:
      declaration?.taxNumber ??
      (statement?.vatIdentificationNumber != null
        ? String(statement.vatIdentificationNumber)
        : null),
    periodStart: declaration?.declarationPeriodStart ?? statement?.statementPeriodStart ?? null,
    periodEnd: declaration?.declarationPeriodEnd ?? statement?.statementPeriodEnd ?? null,
    isStatement: !declaration && !!statement,
    declarationType: (declaration?.declarationType as string | undefined) ?? null,
    method:
      ((declaration?.declarationMethod ?? statement?.statementMethod) as string | undefined) ??
      null,
    frequency:
      ((declaration?.declarationFrequency ?? statement?.statementFrequency) as
        string | undefined) ?? null,
    version: declaration?.version ?? statement?.version ?? null,
  };
}

/**
 * List every VAT return filed in a taxpoint-date range, normalised.
 *
 * Reads BOTH the analytics declarations and the traditional statements, walking
 * the 35-day windows, de-duplicates by processing id (a return can appear in
 * both lists), and maps each to a {@link VatReturnSummary}.
 */
export async function listVatReturns(
  client: EvatClient,
  range: TaxpointWindow,
): Promise<VatReturnSummary[]> {
  const [declarations, statements] = await Promise.all([
    queryAllDeclarations(client, range),
    queryAllStatements(client, range),
  ]);
  const seen = new Set<string>();
  const rows: VatReturnSummary[] = [];
  for (const item of [...declarations, ...statements]) {
    if (seen.has(item.declarationProcessingId)) continue;
    seen.add(item.declarationProcessingId);
    rows.push(summariseDeclaration(item));
  }
  return rows;
}
