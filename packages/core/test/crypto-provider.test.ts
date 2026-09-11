import { createCipheriv } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { passwordHash, sha3_512, sha512 } from '../src/crypto/hash.js';
import { createRequestId, assertRequestId } from '../src/crypto/request-id.js';
import { decodeExchangeToken } from '../src/crypto/token.js';
import { getCryptoProvider, setCryptoProvider } from '../src/crypto/provider.js';
import { nodeCryptoProvider } from '../src/crypto/node-provider.js';
import { createWebCryptoProvider } from '../src/crypto/web-provider.js';

// The web provider (noble + WebCrypto) must be a byte-for-byte drop-in for the
// node provider, so the library behaves identically on Cloudflare Workers etc.
describe('web crypto provider', () => {
  afterEach(() => setCryptoProvider(nodeCryptoProvider));

  it('is not the default provider', () => {
    expect(getCryptoProvider()).toBe(nodeCryptoProvider);
  });

  it('computes the same SHA-512 / SHA3-512 NIST vectors', () => {
    setCryptoProvider(createWebCryptoProvider());
    expect(sha512('abc')).toBe(
      'DDAF35A193617ABACC417349AE20413112E6FA4E89A97EA20A9EEEE64B55D39A' +
        '2192992A274FC1A836BA3C23A3FEEBBD454D4423643CE80E2A9AC94FA54CA49F',
    );
    expect(sha3_512('abc')).toBe(
      'B751850B1A57168A5693CD924B6B096E08F621827444F70D884F5D0240D2712E' +
        '10E116E9192AF3C91A7EC57647E3934057340B4CF408D5A56592F8274EEC53F0',
    );
    expect(passwordHash('any password')).toBe(sha512('any password'));
  });

  it('decrypts an exchange token encrypted by node crypto', () => {
    const exchangeKey = '0123456789abcdef';
    const token = 'ABCDEFGHIJKLMNOP';
    const cipher = createCipheriv('aes-128-ecb', Buffer.from(exchangeKey, 'utf8'), null);
    cipher.setAutoPadding(false);
    const encoded = Buffer.concat([
      cipher.update(Buffer.from(token, 'utf8')),
      cipher.final(),
    ]).toString('base64');

    setCryptoProvider(createWebCryptoProvider());
    expect(decodeExchangeToken(encoded, exchangeKey)).toBe(token);
  });

  it('generates valid request ids from WebCrypto randomness', () => {
    setCryptoProvider(createWebCryptoProvider());
    const ids = new Set<string>();
    for (let i = 0; i < 500; i += 1) {
      const id = createRequestId();
      expect(() => assertRequestId(id)).not.toThrow();
      ids.add(id);
    }
    expect(ids.size).toBe(500);
  });
});
