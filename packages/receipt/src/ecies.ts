import {
  createCipheriv,
  createDecipheriv,
  createECDH,
  createHash,
  createHmac,
  timingSafeEqual,
} from 'node:crypto';

/**
 * ECIES encryption of the customer's receipt copy (eNyugta §4.5).
 *
 * This is the **customer-facing** flow, separate from the NAV submission
 * envelope: the customer presents their SECP256R1 public key (via QR), and the
 * register encrypts the receipt so only the customer's private key can read it.
 * It does NOT touch the submission `decryptKey`, which is sent to NAV in the
 * clear over mutual TLS (§4.5.2).
 *
 * Parameters (§4.5.2, IEEE 1363a): ECDH key agreement, KDF2 with SHA-256 over
 * `crpub || s`, AES-256-CBC (IV = 16×0, PKCS#7), HMAC-SHA-256 over
 * `cxml || encoding` (encoding = 8 zero bytes), compressed public keys.
 *
 * ⚠️ Verified only by an in-process round trip — the KDF2 key-split order and
 * the MAC encoding cannot be pinned to NAV's / the customer app's reference
 * without an official test vector (ONAV-46). Treat interop as unconfirmed.
 */

const CURVE = 'prime256v1'; // SECP256R1 / P-256
const AES_ALGORITHM = 'aes-256-cbc';
const AES_IV = Buffer.alloc(16, 0);
const MAC_ENCODING = Buffer.alloc(8, 0); // the 8 zero bytes appended before the MAC
const KEY_LEN = 32; // AES-256 key
const MAC_KEY_LEN = 32; // HMAC-SHA-256 key

/** A SECP256R1 key pair with keys as raw bytes (public key compressed). */
export interface EcKeyPair {
  /** Compressed public key, 33 bytes (0x02/0x03 prefix + X). */
  publicKey: Uint8Array;
  /** Private key scalar, 32 bytes. */
  privateKey: Uint8Array;
}

/** Generate a SECP256R1 key pair (compressed public key), e.g. the customer's. */
export function generateCustomerKeyPair(): EcKeyPair {
  const ecdh = createECDH(CURVE);
  ecdh.generateKeys();
  return {
    publicKey: new Uint8Array(ecdh.getPublicKey(null, 'compressed')),
    privateKey: new Uint8Array(ecdh.getPrivateKey()),
  };
}

/** The ECIES result carried to the customer (all base64). */
export interface CustomerReceipt {
  /** The register's ephemeral compressed public key (`crpub`). */
  crpub: string;
  /** HMAC-SHA-256 tag over `cxml || encoding` (`cmac`). */
  cmac: string;
  /** AES-256-CBC ciphertext of the receipt (`cxml`). */
  cxml: string;
}

/** I2OSP: a non-negative integer as a big-endian byte string of fixed length. */
function i2osp(value: number, length: number): Buffer {
  const out = Buffer.alloc(length);
  out.writeUInt32BE(value >>> 0, length - 4);
  return out;
}

/**
 * KDF2 (ISO 18033-2 / IEEE 1363a) with SHA-256: hash `input || I2OSP(counter)`
 * for counter = 1, 2, … until `length` bytes are produced.
 */
function kdf2(input: Buffer, length: number): Buffer {
  const blocks: Buffer[] = [];
  let produced = 0;
  for (let counter = 1; produced < length; counter++) {
    const block = createHash('sha256').update(input).update(i2osp(counter, 4)).digest();
    blocks.push(block);
    produced += block.length;
  }
  return Buffer.concat(blocks).subarray(0, length);
}

/** Derive (kenc, kmac) from the register public key and the shared secret. */
function deriveKeys(crpub: Buffer, sharedSecret: Buffer): { kenc: Buffer; kmac: Buffer } {
  // KDF input is crpub concatenated with the shared secret (§4.5.2).
  const keyMaterial = kdf2(Buffer.concat([crpub, sharedSecret]), KEY_LEN + MAC_KEY_LEN);
  return {
    kenc: keyMaterial.subarray(0, KEY_LEN),
    kmac: keyMaterial.subarray(KEY_LEN, KEY_LEN + MAC_KEY_LEN),
  };
}

function toBuffer(data: Uint8Array | string): Buffer {
  return typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
}

/**
 * Encrypt a receipt for the customer with ECIES, given the customer's compressed
 * SECP256R1 public key. Generates a fresh per-transaction key pair.
 */
export function encryptCustomerReceipt(
  receipt: Uint8Array | string,
  customerPublicKey: Uint8Array,
): CustomerReceipt {
  const ecdh = createECDH(CURVE);
  ecdh.generateKeys();
  const crpub = ecdh.getPublicKey(null, 'compressed');
  const sharedSecret = ecdh.computeSecret(Buffer.from(customerPublicKey));
  const { kenc, kmac } = deriveKeys(crpub, sharedSecret);

  const cipher = createCipheriv(AES_ALGORITHM, kenc, AES_IV);
  const cxml = Buffer.concat([cipher.update(toBuffer(receipt)), cipher.final()]);
  const cmac = createHmac('sha256', kmac).update(cxml).update(MAC_ENCODING).digest();

  return {
    crpub: crpub.toString('base64'),
    cmac: cmac.toString('base64'),
    cxml: cxml.toString('base64'),
  };
}

/**
 * Decrypt a {@link CustomerReceipt} with the customer's private key (the
 * customer-app side). Throws if the MAC does not verify.
 */
export function decryptCustomerReceipt(
  receipt: CustomerReceipt,
  customerPrivateKey: Uint8Array,
): Uint8Array {
  const crpub = Buffer.from(receipt.crpub, 'base64');
  const cxml = Buffer.from(receipt.cxml, 'base64');
  const cmac = Buffer.from(receipt.cmac, 'base64');

  const ecdh = createECDH(CURVE);
  ecdh.setPrivateKey(Buffer.from(customerPrivateKey));
  const sharedSecret = ecdh.computeSecret(crpub);
  const { kenc, kmac } = deriveKeys(crpub, sharedSecret);

  const expected = createHmac('sha256', kmac).update(cxml).update(MAC_ENCODING).digest();
  if (expected.length !== cmac.length || !timingSafeEqual(expected, cmac)) {
    throw new Error('customer receipt MAC verification failed');
  }

  const decipher = createDecipheriv(AES_ALGORITHM, kenc, AES_IV);
  return new Uint8Array(Buffer.concat([decipher.update(cxml), decipher.final()]));
}
