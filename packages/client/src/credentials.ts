import { NavValidationError, type ValidationIssue } from '@open-nav/core';

/**
 * Credentials of a technical user (technikai felhasználó), created in the
 * Online Számla portal under the taxpayer whose data is being reported.
 *
 * These are secrets. Load them from the environment or a secret manager —
 * never from source control — and note that the test and production systems
 * issue separate, non-interchangeable users.
 */
export interface NavCredentials {
  /** Technical user login, 6–15 alphanumeric characters. */
  login: string;
  /** Technical user password, in clear; it is hashed before transmission. */
  password: string;
  /** Signature key (aláírókulcs) used to sign requests. */
  signKey: string;
  /** Exchange key (cserekulcs) used to decrypt the exchange token. */
  exchangeKey: string;
  /** Tax number of the taxpayer being reported for, 8 digits, no VAT suffix. */
  taxNumber: string;
}

/**
 * Check credentials locally before the first request.
 *
 * NAV answers every credential problem with the same opaque
 * `INVALID_SECURITY_USER`, so catching shape errors here saves real debugging
 * time. The most common cause is pasting the 11-digit tax number instead of
 * the 8-digit core.
 */
export function assertCredentials(credentials: NavCredentials): void {
  const issues: ValidationIssue[] = [];
  const require = (
    field: keyof NavCredentials,
    pattern: RegExp,
    message: string,
    code: string,
  ): void => {
    const value = credentials[field];
    if (typeof value !== 'string' || value.length === 0) {
      issues.push({ path: `credentials.${field}`, code: 'REQUIRED', message: 'is required' });
    } else if (!pattern.test(value)) {
      issues.push({ path: `credentials.${field}`, code, message });
    }
  };

  require('login', /^[a-zA-Z0-9]{6,15}$/, 'must be 6-15 alphanumeric characters', 'INVALID_LOGIN');
  require('password', /^.+$/, 'must not be empty', 'INVALID_PASSWORD');
  require('signKey', /^.+$/, 'must not be empty', 'INVALID_SIGN_KEY');
  require('exchangeKey', /^.{16}$/, 'must be exactly 16 characters', 'INVALID_EXCHANGE_KEY');
  require('taxNumber', /^\d{8}$/, 'must be the 8 digit core tax number, without the VAT and county digits', 'INVALID_TAX_NUMBER');

  if (issues.length > 0) {
    throw new NavValidationError('Invalid NAV credentials', issues);
  }
}
