import { NavValidationError } from './errors.js';
import { parseTaxNumber } from './validation/tax-number.js';

/**
 * NAV's `softwareId` is a self-assigned 18-character identifier
 * (`[0-9A-Z-]{18}`) sent in the `software` block of every request. NAV does not
 * issue or reserve it; it identifies which software produced a report.
 */
const SOFTWARE_ID_PATTERN = /^[0-9A-Z-]{18}$/;

/** Whether a string is a valid NAV `softwareId` (exactly 18 of `[0-9A-Z-]`). */
export function isValidSoftwareId(value: string): boolean {
  return SOFTWARE_ID_PATTERN.test(value);
}

/** Throw a {@link NavValidationError} unless `value` is a valid `softwareId`. */
export function assertSoftwareId(value: string): void {
  if (!isValidSoftwareId(value)) {
    throw new NavValidationError('Invalid softwareId', [
      {
        path: 'software.softwareId',
        code: 'INVALID_SOFTWARE_ID',
        message: `must be exactly 18 characters of A-Z, 0-9 or "-", got ${JSON.stringify(value)} (${value.length})`,
      },
    ]);
  }
}

/**
 * Build a valid `softwareId` from your tax number and a suffix.
 *
 * There is no registry and uniqueness is not enforced, so prefix the id with
 * your 8-digit tax number to make it globally unique without coordination; the
 * uppercased suffix fills the remaining ten characters (your product/version
 * code). Keep the result stable across releases — the version belongs in
 * `softwareMainVersion`, not here.
 *
 * @example
 * softwareId('27990423', '-SZAMLALI1'); // '27990423-SZAMLALI1'
 * softwareId('12345678-2-41', '-SZAMLALI1'); // '12345678-SZAMLALI1'
 */
export function softwareId(taxNumber: string, suffix: string): string {
  const { taxpayerId } = parseTaxNumber(taxNumber);
  const id = `${taxpayerId}${suffix.toUpperCase()}`;
  assertSoftwareId(id);
  return id;
}
