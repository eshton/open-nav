import { createHash, createDecipheriv, randomBytes } from 'node:crypto';
import type { CryptoProvider } from './provider.js';

/**
 * The default {@link CryptoProvider}, backed by Node's built-in `node:crypto`.
 *
 * Works on Node, Bun and Deno. It does **not** work on Cloudflare Workers,
 * whose `node:crypto` lacks SHA-3 — use {@link createWebCryptoProvider} there.
 */
export const nodeCryptoProvider: CryptoProvider = {
  sha512: (data) => Uint8Array.from(createHash('sha512').update(data).digest()),
  sha3_512: (data) => Uint8Array.from(createHash('sha3-512').update(data).digest()),
  aes128EcbDecrypt: (ciphertext, key) => {
    const decipher = createDecipheriv('aes-128-ecb', key, null);
    decipher.setAutoPadding(false);
    return Uint8Array.from(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
  },
  randomBytes: (length) => Uint8Array.from(randomBytes(length)),
};
