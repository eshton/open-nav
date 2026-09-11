import { describe, expect, it } from 'vitest';
import {
  setCryptoProvider,
  sha512,
  sha3_512,
  passwordHash,
  decodeExchangeToken,
  createRequestId,
  assertRequestId,
} from '../src/index.js';
import { createWebCryptoProvider } from '../src/web.js';

/**
 * The crypto provider, exercised inside workerd.
 *
 * workerd's node:crypto throws for SHA-3, so the default Node provider cannot
 * run the NAV signature here at all. Installing the Web provider (noble +
 * WebCrypto) is what makes the library work on Cloudflare Workers, and this is
 * the test that proves it on the real runtime.
 */
describe('web crypto provider on workerd', () => {
  it('computes the SHA-512 / SHA3-512 vectors', () => {
    setCryptoProvider(createWebCryptoProvider());
    expect(sha512('abc')).toBe(
      'DDAF35A193617ABACC417349AE20413112E6FA4E89A97EA20A9EEEE64B55D39A' +
        '2192992A274FC1A836BA3C23A3FEEBBD454D4423643CE80E2A9AC94FA54CA49F',
    );
    expect(sha3_512('abc')).toBe(
      'B751850B1A57168A5693CD924B6B096E08F621827444F70D884F5D0240D2712E' +
        '10E116E9192AF3C91A7EC57647E3934057340B4CF408D5A56592F8274EEC53F0',
    );
    expect(passwordHash('abc')).toBe(sha512('abc'));
  });

  it('decrypts an AES-128-ECB exchange token', () => {
    setCryptoProvider(createWebCryptoProvider());
    expect(decodeExchangeToken('YlARunu0jNkLN7rPUHP6pw==', '0123456789abcdef')).toBe(
      'TOKEN0123456789A',
    );
  });

  it('generates schema-valid request ids from WebCrypto randomness', () => {
    setCryptoProvider(createWebCryptoProvider());
    const id = createRequestId();
    expect(() => assertRequestId(id)).not.toThrow();
  });
});
