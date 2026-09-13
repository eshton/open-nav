import { getCryptoProvider } from './provider.js';

const encoder = new TextEncoder();

function toHexUpper(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out.toUpperCase();
}

/** Uppercase hexadecimal SHA-512 digest of a UTF-8 string. */
export function sha512(value: string): string {
  return toHexUpper(getCryptoProvider().sha512(encoder.encode(value)));
}

/** Uppercase hexadecimal SHA3-512 digest of a UTF-8 string. */
export function sha3_512(value: string): string {
  return toHexUpper(getCryptoProvider().sha3_512(encoder.encode(value)));
}

/**
 * Uppercase hexadecimal SHA3-512 digest of raw bytes.
 *
 * Used for the eVAT/eNyugta content hash and the file-upload request
 * signature, where the digest is taken over a binary payload rather than text.
 */
export function sha3_512Bytes(data: Uint8Array): string {
  return toHexUpper(getCryptoProvider().sha3_512(data));
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
