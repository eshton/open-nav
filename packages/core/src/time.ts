import { NavValidationError } from './errors.js';

/**
 * Render the `header/timestamp` value: UTC, ISO 8601, millisecond precision,
 * e.g. `2026-09-03T14:25:11.482Z`.
 */
export function toHeaderTimestamp(value: Date | string = new Date()): string {
  return toDate(value).toISOString();
}

/**
 * Render a timestamp the way the request signature consumes it: UTC,
 * `yyyyMMddHHmmss`, truncated to whole seconds, no separators.
 *
 * This must correspond to the same instant as the `header/timestamp` of the
 * request, otherwise NAV rejects the signature.
 */
export function toSignatureTimestamp(value: Date | string = new Date()): string {
  const iso = toDate(value).toISOString();
  // 2026-09-03T14:25:11.482Z -> 20260903142511
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}`;
}

/** Render a NAV `date` field (`xs:date`) as `yyyy-MM-dd` in UTC. */
export function toNavDate(value: Date | string = new Date()): string {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value;
  }
  return toDate(value).toISOString().slice(0, 10);
}

function toDate(value: Date | string): Date {
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) {
    throw new NavValidationError('Invalid timestamp', [
      {
        path: 'timestamp',
        code: 'INVALID_TIMESTAMP',
        message: `cannot be parsed as a date: ${JSON.stringify(value)}`,
      },
    ]);
  }
  return date;
}
