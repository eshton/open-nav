import { createHash } from 'node:crypto';

/** Uppercase hexadecimal SHA-512 digest of a UTF-8 string. */
export function sha512(value: string): string {
  return createHash('sha512').update(value, 'utf8').digest('hex').toUpperCase();
}

/** Uppercase hexadecimal SHA3-512 digest of a UTF-8 string. */
export function sha3_512(value: string): string {
  return createHash('sha3-512').update(value, 'utf8').digest('hex').toUpperCase();
}

/**
 * Hash of the technical user's password for the `user/passwordHash` field.
 *
 * NAV expects the uppercase hex SHA-512 digest of the password, declared on
 * the element with `cryptoType="SHA-512"`.
 */
export function passwordHash(password: string): string {
  return sha512(password);
}

/** `cryptoType` attribute value used for `passwordHash`. */
export const PASSWORD_HASH_CRYPTO_TYPE = 'SHA-512';

/** `cryptoType` attribute value used for `requestSignature` and invoice hashes. */
export const SIGNATURE_CRYPTO_TYPE = 'SHA3-512';
