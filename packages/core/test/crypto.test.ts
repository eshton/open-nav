import { createCipheriv } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { passwordHash, sha3_512, sha512 } from '../src/crypto/hash.js';
import { assertRequestId, createRequestId } from '../src/crypto/request-id.js';
import { decodeExchangeToken } from '../src/crypto/token.js';
import { TYPES } from '../src/generated/schema.js';
import { NavValidationError } from '../src/errors.js';

describe('hashes', () => {
  // Published NIST/FIPS vectors, so a change in Node's crypto backend cannot
  // silently alter what we send to NAV.
  it('computes SHA-512 as uppercase hex', () => {
    expect(sha512('abc')).toBe(
      'DDAF35A193617ABACC417349AE20413112E6FA4E89A97EA20A9EEEE64B55D39A' +
        '2192992A274FC1A836BA3C23A3FEEBBD454D4423643CE80E2A9AC94FA54CA49F',
    );
  });

  it('computes SHA3-512 as uppercase hex', () => {
    expect(sha3_512('abc')).toBe(
      'B751850B1A57168A5693CD924B6B096E08F621827444F70D884F5D0240D2712E' +
        '10E116E9192AF3C91A7EC57647E3934057340B4CF408D5A56592F8274EEC53F0',
    );
  });

  it('hashes the technical user password with SHA-512', () => {
    expect(passwordHash('abc')).toBe(sha512('abc'));
  });

  it('produces digests matching the schema constraints for hashes', () => {
    const sha512Type = TYPES['common:SHA512Type'];
    expect(sha512Type?.kind).toBe('simple');
    if (sha512Type?.kind !== 'simple') throw new Error('unreachable');
    expect(new RegExp(`^${sha512Type.pattern}$`).test(passwordHash('any password'))).toBe(true);
    expect(new RegExp(`^${sha512Type.pattern}$`).test(sha3_512('any payload'))).toBe(true);
  });
});

describe('exchange token', () => {
  const exchangeKey = '0123456789abcdef';

  const encrypt = (plaintext: string, padded: boolean): string => {
    const cipher = createCipheriv('aes-128-ecb', Buffer.from(exchangeKey, 'utf8'), null);
    cipher.setAutoPadding(padded);
    return Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]).toString(
      'base64',
    );
  };

  it('decrypts an unpadded 16 byte token', () => {
    const token = 'ABCDEFGHIJKLMNOP';
    expect(decodeExchangeToken(encrypt(token, false), exchangeKey)).toBe(token);
  });

  it('decrypts a PKCS#7 padded token', () => {
    // NAV has been observed returning both shapes, so both must work.
    const token = 'ABCDEFGHIJKLMNOP';
    expect(decodeExchangeToken(encrypt(token, true), exchangeKey)).toBe(token);
  });

  it('rejects an exchange key of the wrong length', () => {
    expect(() => decodeExchangeToken(encrypt('ABCDEFGHIJKLMNOP', false), 'short')).toThrowError(
      NavValidationError,
    );
  });

  it('rejects a payload that is not a whole number of AES blocks', () => {
    expect(() =>
      decodeExchangeToken(Buffer.from('abc').toString('base64'), exchangeKey),
    ).toThrowError(/block size/);
  });
});

describe('requestId', () => {
  /** NAV constrains requestId through common:EntityIdType. */
  const entityId = TYPES['common:EntityIdType'];
  if (entityId?.kind !== 'simple') throw new Error('EntityIdType missing from generated schema');
  const pattern = new RegExp(`^${entityId.pattern}$`);

  it('generates identifiers the schema accepts', () => {
    for (let i = 0; i < 500; i += 1) {
      const id = createRequestId();
      expect(pattern.test(id), id).toBe(true);
      expect(id.length).toBeLessThanOrEqual(entityId.maxLength ?? 30);
      expect(() => assertRequestId(id)).not.toThrow();
    }
  });

  it('does not repeat itself', () => {
    const ids = new Set(Array.from({ length: 5000 }, () => createRequestId()));
    expect(ids.size).toBe(5000);
  });

  it('honours a caller prefix', () => {
    expect(createRequestId('INV')).toMatch(/^INV/);
  });

  it('rejects a prefix that leaves too little entropy', () => {
    expect(() => createRequestId('A'.repeat(28))).toThrowError(/too long/);
  });

  it('rejects prefixes with characters NAV disallows', () => {
    expect(() => createRequestId('bad-prefix')).toThrowError(NavValidationError);
  });

  it('rejects malformed identifiers', () => {
    expect(() => assertRequestId('has space')).toThrowError(/Invalid requestId/);
    expect(() => assertRequestId('a'.repeat(31))).toThrowError(/Invalid requestId/);
    expect(() => assertRequestId('')).toThrowError(/Invalid requestId/);
  });
});
