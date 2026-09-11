import { getCryptoProvider } from './provider.js';
import { NavValidationError } from '../errors.js';

const EXCHANGE_KEY_LENGTH = 16;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Decode a base64 string to bytes on any runtime (no Node Buffer). */
function base64ToBytes(base64: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(base64);
  } catch {
    throw new NavValidationError('Invalid encoded exchange token', [
      {
        path: 'encodedExchangeToken',
        code: 'EXCHANGE_TOKEN_LENGTH',
        message: 'not valid base64',
      },
    ]);
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Decrypt the `encodedExchangeToken` returned by `tokenExchange`.
 *
 * NAV encrypts the 16 character exchange token with AES-128 in ECB mode using
 * the technical user's exchange key (csereklucs / "XML aláírás kulcs" pair) as
 * the raw key, then base64 encodes the result. Padding is optional in
 * practice: NAV historically returned an unpadded 16 byte block, while some
 * environments return a PKCS#7 padded 32 byte block, so both are accepted.
 *
 * @param encodedToken base64 payload from the response
 * @param exchangeKey  16 character exchange key of the technical user
 */
export function decodeExchangeToken(encodedToken: string, exchangeKey: string): string {
  const keyBytes = encoder.encode(exchangeKey);
  // AES-128 needs a 16-byte key. NAV keys are 16 ASCII characters, so char
  // length and byte length coincide; guard on bytes so a non-ASCII key fails
  // here with a NAV code rather than deep inside the cipher.
  if (keyBytes.length !== EXCHANGE_KEY_LENGTH) {
    throw new NavValidationError('Invalid NAV exchange key', [
      {
        path: 'credentials.exchangeKey',
        code: 'EXCHANGE_KEY_LENGTH',
        message: `must be exactly ${EXCHANGE_KEY_LENGTH} bytes, got ${keyBytes.length}`,
      },
    ]);
  }

  const ciphertext = base64ToBytes(encodedToken);
  if (ciphertext.length === 0 || ciphertext.length % 16 !== 0) {
    throw new NavValidationError('Invalid encoded exchange token', [
      {
        path: 'encodedExchangeToken',
        code: 'EXCHANGE_TOKEN_LENGTH',
        message: `expected a multiple of the 16 byte AES block size, got ${ciphertext.length}`,
      },
    ]);
  }

  const plaintext = getCryptoProvider().aes128EcbDecrypt(ciphertext, keyBytes);

  return decoder.decode(stripPkcs7(plaintext));
}

/**
 * Remove PKCS#7 padding if, and only if, the buffer actually carries it.
 * NAV's unpadded tokens consist of printable ASCII, so a trailing byte in the
 * 1..16 range is an unambiguous padding marker.
 */
function stripPkcs7(buffer: Uint8Array): Uint8Array {
  const last = buffer.at(-1);
  if (last === undefined || last < 1 || last > 16 || last >= buffer.length) {
    return buffer;
  }
  for (let i = buffer.length - last; i < buffer.length; i += 1) {
    if (buffer[i] !== last) {
      return buffer;
    }
  }
  return buffer.subarray(0, buffer.length - last);
}
