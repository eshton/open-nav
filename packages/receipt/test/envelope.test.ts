import { describe, expect, it } from 'vitest';
import {
  buildDocumentEnvelope,
  buildReportEnvelope,
  openEnvelope,
  verifyEnvelopeSignature,
  ENVELOPE_HASH_ALGORITHM,
} from '../src/envelope.js';
import { generateRsaKeyPair } from '../src/crypto.js';
import { canonicalize } from '../src/canon.js';

const keys = generateRsaKeyPair(2048);
const core = '<CoreDocument><receiptNumber>A/1</receiptNumber></CoreDocument>';
const customer = '<CustomerDocument><name>Buyer</name></CustomerDocument>';

describe('buildDocumentEnvelope', () => {
  it('seals both payloads under one key and round-trips them', () => {
    const { envelope, decryptKey } = buildDocumentEnvelope(core, customer, keys.privateKey);

    expect(envelope.envelopeVersion).toBeDefined();
    expect(envelope.envelopeHash.cryptoType).toBe(ENVELOPE_HASH_ALGORITHM);
    // Payloads are base64 and not the plaintext.
    expect(envelope.envelopeData).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(envelope.envelopeData).not.toContain('receiptNumber');

    const opened = openEnvelope(envelope, decryptKey);
    expect(opened.core).toBe(canonicalize(core));
    expect(opened.customer).toBe(canonicalize(customer));
  });

  it('produces a signature that verifies against the signing key', () => {
    const { envelope } = buildDocumentEnvelope(core, customer, keys.privateKey);
    expect(verifyEnvelopeSignature(envelope, keys.publicKey)).toBe(true);
  });

  it('the hash covers envelopeData + customerEnvelopeData', () => {
    const { envelope } = buildDocumentEnvelope(core, customer, keys.privateKey);
    // Tampering with either payload breaks verification.
    const tampered = { ...envelope, envelopeData: envelope.customerEnvelopeData };
    expect(verifyEnvelopeSignature(tampered, keys.publicKey)).toBe(false);
  });
});

describe('buildReportEnvelope', () => {
  it('omits customerEnvelopeData when there is no customer report', () => {
    const report = '<CoreReport><total>100</total></CoreReport>';
    const { envelope, decryptKey } = buildReportEnvelope(report, undefined, keys.privateKey);

    expect(envelope.customerEnvelopeData).toBeUndefined();
    expect(verifyEnvelopeSignature(envelope, keys.publicKey)).toBe(true);
    expect(openEnvelope(envelope, decryptKey).core).toBe(canonicalize(report));
  });
});
