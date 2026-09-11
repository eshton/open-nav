import { sha512 } from '@noble/hashes/sha2';
import { sha3_512 } from '@noble/hashes/sha3';
import { ecb } from '@noble/ciphers/aes';
import type { CryptoProvider } from './provider.js';

/**
 * A {@link CryptoProvider} for runtimes without SHA-3 in `node:crypto` —
 * Cloudflare Workers, browsers, Deno, Bun.
 *
 * Uses `@noble/hashes` for SHA-512 / SHA3-512 (WebCrypto offers neither a
 * synchronous digest nor SHA-3), `@noble/ciphers` for the AES-128-ECB exchange
 * token (WebCrypto has no ECB mode), and `crypto.getRandomValues` for
 * randomness. Every operation is synchronous, matching {@link nodeCryptoProvider}.
 *
 * @example
 * ```ts
 * import { setCryptoProvider, createWebCryptoProvider } from '@open-nav/core';
 * setCryptoProvider(createWebCryptoProvider());
 * ```
 */
export function createWebCryptoProvider(): CryptoProvider {
  return {
    sha512: (data) => sha512(data),
    sha3_512: (data) => sha3_512(data),
    aes128EcbDecrypt: (ciphertext, key) => ecb(key, { disablePadding: true }).decrypt(ciphertext),
    randomBytes: (length) => {
      const bytes = new Uint8Array(length);
      globalThis.crypto.getRandomValues(bytes);
      return bytes;
    },
  };
}
