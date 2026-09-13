import { describe, expect, it } from 'vitest';
import { gunzipSync, gzipSync } from 'node:zlib';
import forge from 'node-forge';
import {
  decryptDocument,
  encryptDocument,
  generateCsr,
  generateEncryptionKeyPair,
  generateRsaKeyPair,
  parseCertificate,
  signEnvelope,
  verifyEnvelope,
} from '../src/crypto.js';

describe('encryptDocument / decryptDocument', () => {
  it('round-trips a compressed document with a fresh key', () => {
    const payload = gzipSync(Buffer.from('<CoreDocument>…</CoreDocument>', 'utf8'));
    const { ciphertext, keyBase64 } = encryptDocument(new Uint8Array(payload));
    expect(Buffer.from(keyBase64, 'base64')).toHaveLength(32);
    const back = decryptDocument(ciphertext, keyBase64);
    expect(gunzipSync(Buffer.from(back)).toString('utf8')).toBe('<CoreDocument>…</CoreDocument>');
  });

  it('uses a different key each call', () => {
    const a = encryptDocument(new Uint8Array([1, 2, 3]));
    const b = encryptDocument(new Uint8Array([1, 2, 3]));
    expect(a.keyBase64).not.toBe(b.keyBase64);
  });
});

describe('signEnvelope / verifyEnvelope', () => {
  it('signs a payload and verifies against the public key', () => {
    const { privateKey, publicKey } = generateRsaKeyPair();
    const payload = Buffer.from('some-base64-data').toString('base64');
    const { envelopeHash, envelopeSignature } = signEnvelope(payload, privateKey);
    expect(envelopeHash).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(verifyEnvelope(payload, envelopeSignature, publicKey)).toBe(true);
    expect(verifyEnvelope(payload + 'x', envelopeSignature, publicKey)).toBe(false);
  });
});

describe('key pairs and certificates', () => {
  it('generates a P-256 encryption key pair', () => {
    const { privateKey, publicKey } = generateEncryptionKeyPair();
    expect(privateKey).toContain('BEGIN PRIVATE KEY');
    expect(publicKey).toContain('BEGIN PUBLIC KEY');
  });

  it('generates a PKCS#10 CSR with the requested common name and a matching key', () => {
    const { csrPem, privateKeyPem, publicKeyPem } = generateCsr('AP12345678', 1024);
    expect(csrPem).toContain('BEGIN CERTIFICATE REQUEST');
    expect(privateKeyPem).toContain('PRIVATE KEY');
    expect(publicKeyPem).toContain('BEGIN PUBLIC KEY');

    const csr = forge.pki.certificationRequestFromPem(csrPem);
    expect(csr.subject.getField('CN')?.value).toBe('AP12345678');
    // The CSR is self-signed with the request key.
    expect(csr.verify()).toBe(true);
  });

  it('rejects input that is not a certificate', () => {
    // Real NAV-issued certs are exercised in the registration flow (ONAV-40);
    // here just confirm the parser fails loudly on non-cert input.
    expect(() => parseCertificate('not a cert')).toThrow();
  });
});
