import { createDecipheriv } from 'node:crypto';
import { NavValidationError } from '../errors.js';

const EXCHANGE_KEY_LENGTH = 16;

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
  if (exchangeKey.length !== EXCHANGE_KEY_LENGTH) {
    throw new NavValidationError('Invalid NAV exchange key', [
      {
        path: 'credentials.exchangeKey',
        code: 'EXCHANGE_KEY_LENGTH',
        message: `must be exactly ${EXCHANGE_KEY_LENGTH} characters, got ${exchangeKey.length}`,
      },
    ]);
  }

  const ciphertext = Buffer.from(encodedToken, 'base64');
  if (ciphertext.length === 0 || ciphertext.length % 16 !== 0) {
    throw new NavValidationError('Invalid encoded exchange token', [
      {
        path: 'encodedExchangeToken',
        code: 'EXCHANGE_TOKEN_LENGTH',
        message: `expected a multiple of the 16 byte AES block size, got ${ciphertext.length}`,
      },
    ]);
  }

  const decipher = createDecipheriv('aes-128-ecb', Buffer.from(exchangeKey, 'utf8'), null);
  decipher.setAutoPadding(false);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  return stripPkcs7(plaintext).toString('utf8');
}

/**
 * Remove PKCS#7 padding if, and only if, the buffer actually carries it.
 * NAV's unpadded tokens consist of printable ASCII, so a trailing byte in the
 * 1..16 range is an unambiguous padding marker.
 */
function stripPkcs7(buffer: Buffer): Buffer {
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
