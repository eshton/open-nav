import { nodeCryptoProvider } from './node-provider.js';

/**
 * The low-level cryptographic primitives the NAV protocol needs, abstracted so
 * the library can run on any JavaScript runtime.
 *
 * The default is {@link nodeCryptoProvider}, backed by Node's built-in
 * `node:crypto`. On runtimes whose `node:crypto` lacks SHA-3 — notably
 * Cloudflare Workers (workerd/BoringSSL), where `createHash('sha3-512')` throws
 * `Digest method not supported` — install {@link createWebCryptoProvider} via
 * {@link setCryptoProvider} once at startup, before making any request.
 */
export interface CryptoProvider {
  /** Raw SHA-512 digest of `data`. */
  sha512(data: Uint8Array): Uint8Array;
  /** Raw SHA3-512 digest of `data`. */
  sha3_512(data: Uint8Array): Uint8Array;
  /** AES-128 ECB decryption without padding; `key` is exactly 16 bytes. */
  aes128EcbDecrypt(ciphertext: Uint8Array, key: Uint8Array): Uint8Array;
  /** `length` cryptographically strong random bytes. */
  randomBytes(length: number): Uint8Array;
}

let activeProvider: CryptoProvider = nodeCryptoProvider;

/** The crypto provider currently backing every cryptographic helper. */
export function getCryptoProvider(): CryptoProvider {
  return activeProvider;
}

/**
 * Replace the active crypto provider. Call once at startup, before any NAV
 * request — e.g. `setCryptoProvider(createWebCryptoProvider())` in a Worker.
 */
export function setCryptoProvider(provider: CryptoProvider): void {
  activeProvider = provider;
}
