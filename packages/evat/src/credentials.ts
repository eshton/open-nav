import { NavValidationError, type ValidationIssue } from '@open-nav/core';

/**
 * Technical-user credentials for the eVAT M2M interface.
 *
 * These are the *same* technical user, signature key and exchange key created
 * in the Online Invoice System — eVAT reuses them (see the EVAT-1 findings).
 * The taxNumber is the 8-digit core of the taxpayer's number.
 */
export interface EvatCredentials {
  /** Technical user login name. */
  login: string;
  /** Technical user password (hashed by the client, never sent in clear). */
  password: string;
  /** Signature key, used to sign each request. */
  signKey: string;
  /** Exchange key, used to decrypt data-transfer tokens on download operations. */
  exchangeKey?: string;
  /** The taxpayer's 8-digit tax number. */
  taxNumber: string;
}

/** Throw unless the credentials carry everything a request needs. */
export function assertEvatCredentials(credentials: EvatCredentials): void {
  const issues: ValidationIssue[] = [];
  const require = (field: keyof EvatCredentials, label: string): void => {
    const value = credentials[field];
    if (typeof value !== 'string' || value.trim() === '') {
      issues.push({ path: field, code: 'REQUIRED', message: `${label} is required` });
    }
  };
  require('login', 'login');
  require('password', 'password');
  require('signKey', 'signKey');
  require('taxNumber', 'taxNumber');
  if (credentials.taxNumber && !/^\d{8}$/.test(credentials.taxNumber)) {
    issues.push({
      path: 'taxNumber',
      code: 'INVALID_TAX_NUMBER',
      message: 'taxNumber must be the 8-digit core of the tax number',
    });
  }
  if (issues.length > 0) throw new NavValidationError('Invalid eVAT credentials', issues);
}
