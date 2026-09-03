import { randomBytes } from 'node:crypto';
import { REQUEST_ID_MAX_LENGTH, REQUEST_ID_PATTERN } from '../constants.js';
import { NavValidationError } from '../errors.js';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Generate a `requestId` that satisfies NAV's constraints.
 *
 * NAV requires the value to match `[+a-zA-Z0-9_]{1,30}` and to be unique for
 * the taxpayer across all requests ever sent — a replayed identifier is
 * rejected with `INVALID_REQUEST_ID`. The generated value combines a
 * millisecond timestamp with random characters, which is collision safe for
 * practical throughput, but persisting issued identifiers is still the only
 * way to be certain after a clock change.
 *
 * @param prefix optional caller prefix, useful for tracing (`[a-zA-Z0-9_+]`)
 */
export function createRequestId(prefix = 'ON'): string {
  assertRequestIdChars(prefix, 'prefix');
  const stamp = Date.now().toString(36).toUpperCase();
  const available = REQUEST_ID_MAX_LENGTH - prefix.length - stamp.length;
  if (available < 4) {
    throw new NavValidationError('requestId prefix is too long', [
      {
        path: 'prefix',
        code: 'REQUEST_ID_PREFIX_TOO_LONG',
        message: `leaves only ${available} characters of entropy, need at least 4`,
      },
    ]);
  }
  return `${prefix}${stamp}${randomChars(Math.min(available, 8))}`;
}

/** Throw unless `value` is a valid `requestId`. */
export function assertRequestId(value: string): void {
  if (!REQUEST_ID_PATTERN.test(value)) {
    throw new NavValidationError('Invalid requestId', [
      {
        path: 'requestId',
        code: 'INVALID_REQUEST_ID',
        message: `must match ${REQUEST_ID_PATTERN.source}, got ${JSON.stringify(value)}`,
      },
    ]);
  }
}

function assertRequestIdChars(value: string, path: string): void {
  if (!/^[+a-zA-Z0-9_]*$/.test(value)) {
    throw new NavValidationError('Invalid requestId characters', [
      { path, code: 'INVALID_REQUEST_ID', message: 'may only contain [+a-zA-Z0-9_]' },
    ]);
  }
}

function randomChars(length: number): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += ALPHABET[bytes[i]! % ALPHABET.length];
  }
  return out;
}
