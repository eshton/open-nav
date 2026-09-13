import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createSign,
  createVerify,
  generateKeyPairSync,
  randomBytes,
  X509Certificate,
} from 'node:crypto';
import forge from 'node-forge';

/**
 * eNyugta receipt cryptography (Node stdlib only).
 *
 * Implements the parts of the e-cash-register crypto model that Node's `crypto`
 * covers directly: AES-256-CBC document encryption, RSA-SHA256 envelope
 * signing, the SECP256R1 encryption key pair, and certificate parsing. The two
 * pieces stdlib does NOT cover — PKCS#10 CSR generation and XML canonicalisation
 * (RFC 3076) — are tracked separately (ONAV-38 CSR, ONAV-39) and depend on a
 * library choice.
 *
 * @see the eNyugta design on ONAV-37.
 */

/** AES parameters fixed by the spec (§4.5.2). */
const AES_ALGORITHM = 'aes-256-cbc';
const AES_IV = Buffer.alloc(16, 0); // "Initialization vector value: 16 x [0]"

/** An encrypted document plus the single-use key that decrypts it. */
export interface EncryptedDocument {
  /** AES-256-CBC ciphertext of the (compressed) document bytes. */
  ciphertext: Uint8Array;
  /** The fresh 32-byte AES key, base64 — as carried in the request `decryptKey`. */
  keyBase64: string;
}

/**
 * Encrypt a document body with a fresh AES-256-CBC key.
 *
 * The spec mandates a new random 32-byte key per document, a zero IV and PKCS#7
 * padding. The input is the binary result of compression; the key is returned
 * for the request's `decryptKey` field.
 */
export function encryptDocument(compressed: Uint8Array): EncryptedDocument {
  const key = randomBytes(32);
  const cipher = createCipheriv(AES_ALGORITHM, key, AES_IV); // PKCS#7 padding is on by default
  const ciphertext = Buffer.concat([cipher.update(compressed), cipher.final()]);
  return { ciphertext: new Uint8Array(ciphertext), keyBase64: key.toString('base64') };
}

/** Decrypt an AES-256-CBC document body given its base64 key. */
export function decryptDocument(ciphertext: Uint8Array, keyBase64: string): Uint8Array {
  const key = Buffer.from(keyBase64, 'base64');
  const decipher = createDecipheriv(AES_ALGORITHM, key, AES_IV);
  const plain = Buffer.concat([decipher.update(Buffer.from(ciphertext)), decipher.final()]);
  return new Uint8Array(plain);
}

/** The signature fields of a signed envelope. */
export interface EnvelopeSignature {
  /** SHA-256 of the concatenated base64 payload(s), base64 — the `envelopeHash`. */
  envelopeHash: string;
  /** RSA signature over that payload, base64 — the `envelopeSignature`. */
  envelopeSignature: string;
}

/**
 * Sign an envelope's base64 payload with the signing certificate's key (§4.2).
 *
 * `envelopeSignature` is the RSA signature computed over the SHA-256 hash of the
 * base64 data; `envelopeHash` is the SHA-256 of the concatenated base64
 * strings, base64-encoded. Pass `envelopeData` alone, or
 * `envelopeData + customerEnvelopeData` concatenated, as `payloadBase64`.
 */
export function signEnvelope(payloadBase64: string, signingKeyPem: string): EnvelopeSignature {
  const key = createPrivateKey(signingKeyPem);
  const envelopeHash = createHash('sha256').update(payloadBase64, 'utf8').digest('base64');
  const signature = createSign('sha256').update(payloadBase64, 'utf8').sign(key).toString('base64');
  return { envelopeHash, envelopeSignature: signature };
}

/** Verify an envelope signature against the signing certificate (PEM). */
export function verifyEnvelope(
  payloadBase64: string,
  envelopeSignature: string,
  signingCertPem: string,
): boolean {
  return createVerify('sha256')
    .update(payloadBase64, 'utf8')
    .verify(signingCertPem, Buffer.from(envelopeSignature, 'base64'));
}

/** A PEM key pair. */
export interface KeyPairPem {
  privateKey: string;
  publicKey: string;
}

/** Generate an RSA key pair for a signing/authentication certificate request. */
export function generateRsaKeyPair(modulusLength = 2048): KeyPairPem {
  return generateKeyPairSync('rsa', {
    modulusLength,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

/**
 * Generate the SECP256R1 (P-256) encryption key pair used to protect the
 * customer-data key (§4.5.1, RFC 5480).
 */
export function generateEncryptionKeyPair(): KeyPairPem {
  return generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

/** A PKCS#10 CSR and the key pair it was generated for. */
export interface CsrResult {
  /** The PKCS#10 certificate signing request, PEM. */
  csrPem: string;
  /** The RSA private key, PKCS#8 PEM — store this securely. */
  privateKeyPem: string;
  /** The RSA public key, SPKI PEM. */
  publicKeyPem: string;
}

/**
 * Generate an RSA key pair and a PKCS#10 CSR for a NAV-issued certificate.
 *
 * During device registration the e-cash register submits a CSR for each of the
 * authentication and signing certificates; NAV inserts the business data, so
 * the CSR only needs the common name (the AP number). Returns the CSR and the
 * key pair; the private key must be stored securely (a hardware register keeps
 * it in a hardware key store).
 *
 * @param commonName the certificate common name, e.g. the AP number `AP12345678`.
 */
export function generateCsr(commonName: string, modulusLength = 2048): CsrResult {
  const keys = forge.pki.rsa.generateKeyPair(modulusLength);
  const csr = forge.pki.createCertificationRequest();
  csr.publicKey = keys.publicKey;
  csr.setSubject([{ shortName: 'CN', value: commonName }]);
  csr.sign(keys.privateKey, forge.md.sha256.create());
  return {
    csrPem: forge.pki.certificationRequestToPem(csr),
    privateKeyPem: forge.pki.privateKeyToPem(keys.privateKey),
    publicKeyPem: forge.pki.publicKeyToPem(keys.publicKey),
  };
}

/** Summary of an X.509 certificate NAV issued. */
export interface CertificateInfo {
  subject: string;
  issuer: string;
  validFrom: string;
  validTo: string;
  serialNumber: string;
}

/** Parse a NAV-issued certificate (PEM or DER) for its validity window. */
export function parseCertificate(certificate: string | Uint8Array): CertificateInfo {
  const x509 = new X509Certificate(
    typeof certificate === 'string' ? certificate : Buffer.from(certificate),
  );
  return {
    subject: x509.subject,
    issuer: x509.issuer,
    validFrom: x509.validFrom,
    validTo: x509.validTo,
    serialNumber: x509.serialNumber,
  };
}
