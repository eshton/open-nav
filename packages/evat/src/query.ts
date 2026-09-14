import type { EvatClient } from './client.js';
import type { AnalyticsListItemType } from './generated/types.js';

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
