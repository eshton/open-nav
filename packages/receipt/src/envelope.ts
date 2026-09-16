import { gunzipSync, gzipSync } from 'node:zlib';
import { MAX_DECOMPRESSED_BYTES } from '@open-nav/core';
import { canonicalize } from './canon.js';
import {
  decryptDocument,
  encryptWithKey,
  generateAesKey,
  signEnvelope,
  verifyEnvelope,
} from './crypto.js';
import type { SignedDocumentEnvelopeType, SignedReportEnvelopeType } from './generated/types.js';

/**
 * Signed-envelope construction for the eNyugta data services (§4).
 *
 * The document/report data the register submits is not sent in the clear: each
 * payload is canonicalised (RFC 3076, {@link canonicalize}), gzip-compressed,
 * AES-256-CBC encrypted (one fresh key per envelope, the request `decryptKey`),
 * base64-encoded, and finally the concatenated base64 is RSA-SHA256 signed with
 * the register's signing key. The result is a
 * {@link SignedDocumentEnvelopeType} / {@link SignedReportEnvelopeType} plus the
 * `decryptKey` to put on the request.
 *
 * @see ONAV-38 (crypto primitives), ONAV-39 (C14N).
 */

/** Hash algorithm named in the envelope's `envelopeHash.cryptoType`. */
export const ENVELOPE_HASH_ALGORITHM = 'SHA-256';
/** Data-model version stamped into `envelopeVersion`. */
export const ENVELOPE_VERSION = '1.0';

/** A built envelope together with the single-use key that decrypts it. */
export interface BuiltEnvelope<T> {
  envelope: T;
  /**
   * The fresh AES-256 key (base64) — set as the request's `decryptKey`. Sent to
   * NAV in the clear over mutual TLS, exactly as §4.5.2 specifies (it is not
   * key-wrapped; the customer-facing ECIES flow is a separate concern).
   */
  decryptKey: string;
}

/** Canonicalise → gzip → AES-256-CBC → base64. */
function seal(xml: string, keyBase64: string): string {
  const compressed = gzipSync(Buffer.from(canonicalize(xml), 'utf8'));
  return Buffer.from(encryptWithKey(compressed, keyBase64)).toString('base64');
}

/** base64 → AES-256-CBC decrypt → gunzip → utf8. The inverse of {@link seal}. */
function unseal(payloadBase64: string, keyBase64: string): string {
  const compressed = decryptDocument(
    new Uint8Array(Buffer.from(payloadBase64, 'base64')),
    keyBase64,
  );
  // Capped like every other decompression here: the ciphertext is whatever the
  // peer sent, and a small gzip stream expands without bound.
  return gunzipSync(Buffer.from(compressed), {
    maxOutputLength: MAX_DECOMPRESSED_BYTES,
  }).toString('utf8');
}

/**
 * Build a signed document envelope from the serialized `CoreDocument` and
 * `CustomerDocument` XML.
 *
 * Both payloads are sealed with one fresh key; the signature and hash cover the
 * concatenation `envelopeData + customerEnvelopeData`.
 */
export function buildDocumentEnvelope(
  coreDocumentXml: string,
  customerDocumentXml: string,
  signingKeyPem: string,
): BuiltEnvelope<SignedDocumentEnvelopeType> {
  const decryptKey = generateAesKey();
  // Both payloads are sealed with the same key and the spec's fixed zero IV
  // (§4.5.2, one decryptKey per request): a known, spec-mandated property, so a
  // shared block-aligned prefix (e.g. the gzip header) yields an identical
  // ciphertext prefix across the two parts. Not a defect we can avoid here.
  const envelopeData = seal(coreDocumentXml, decryptKey);
  const customerEnvelopeData = seal(customerDocumentXml, decryptKey);
  const { envelopeHash, envelopeSignature } = signEnvelope(
    envelopeData + customerEnvelopeData,
    signingKeyPem,
  );
  return {
    envelope: {
      envelopeVersion: ENVELOPE_VERSION,
      envelopeData,
      customerEnvelopeData,
      envelopeHash: { value: envelopeHash, cryptoType: ENVELOPE_HASH_ALGORITHM },
      envelopeSignature,
    },
    decryptKey,
  };
}

/**
 * Build a signed report envelope from the serialized `CoreReport` XML, with an
 * optional `CustomerReport` (reports may omit customer data).
 */
export function buildReportEnvelope(
  coreReportXml: string,
  customerReportXml: string | undefined,
  signingKeyPem: string,
): BuiltEnvelope<SignedReportEnvelopeType> {
  const decryptKey = generateAesKey();
  const envelopeData = seal(coreReportXml, decryptKey);
  const customerEnvelopeData =
    customerReportXml === undefined ? undefined : seal(customerReportXml, decryptKey);
  const { envelopeHash, envelopeSignature } = signEnvelope(
    envelopeData + (customerEnvelopeData ?? ''),
    signingKeyPem,
  );
  return {
    envelope: {
      envelopeVersion: ENVELOPE_VERSION,
      envelopeData,
      ...(customerEnvelopeData ? { customerEnvelopeData } : {}),
      envelopeHash: { value: envelopeHash, cryptoType: ENVELOPE_HASH_ALGORITHM },
      envelopeSignature,
    },
    decryptKey,
  };
}

/** The plaintext (canonical) XML recovered from a signed envelope. */
export interface OpenedEnvelope {
  core: string;
  customer?: string;
}

/**
 * Recover the canonical `CoreDocument`/`CoreReport` (and customer) XML from a
 * signed envelope given its `decryptKey`. Used to read received reports and to
 * verify round trips.
 */
export function openEnvelope(
  envelope: SignedDocumentEnvelopeType | SignedReportEnvelopeType,
  decryptKey: string,
): OpenedEnvelope {
  return {
    core: unseal(envelope.envelopeData, decryptKey),
    ...(envelope.customerEnvelopeData
      ? { customer: unseal(envelope.customerEnvelopeData, decryptKey) }
      : {}),
  };
}

/**
 * Verify an envelope's signature against the register's signing certificate
 * (PEM). Checks the RSA-SHA256 signature over `envelopeData +
 * customerEnvelopeData`.
 */
export function verifyEnvelopeSignature(
  envelope: SignedDocumentEnvelopeType | SignedReportEnvelopeType,
  signingCertPem: string,
): boolean {
  return verifyEnvelope(
    envelope.envelopeData + (envelope.customerEnvelopeData ?? ''),
    envelope.envelopeSignature,
    signingCertPem,
  );
}
