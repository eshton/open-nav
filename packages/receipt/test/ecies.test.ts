import { describe, expect, it } from 'vitest';
import {
  decryptCustomerReceipt,
  encryptCustomerReceipt,
  generateCustomerKeyPair,
} from '../src/ecies.js';

describe('ECIES customer receipt', () => {
  it('round-trips: the customer decrypts what the register encrypted', () => {
    const customer = generateCustomerKeyPair();
    const receipt = '<CustomerDocument><total>1270</total></CustomerDocument>';

    const sealed = encryptCustomerReceipt(receipt, customer.publicKey);
    // The ephemeral register key is carried compressed (33 bytes).
    expect(Buffer.from(sealed.crpub, 'base64')).toHaveLength(33);
    expect(sealed.cxml).not.toContain('CustomerDocument');

    const opened = decryptCustomerReceipt(sealed, customer.privateKey);
    expect(new TextDecoder().decode(opened)).toBe(receipt);
  });

  it('uses a fresh ephemeral key pair per call', () => {
    const customer = generateCustomerKeyPair();
    const a = encryptCustomerReceipt('x', customer.publicKey);
    const b = encryptCustomerReceipt('x', customer.publicKey);
    expect(a.crpub).not.toBe(b.crpub);
    expect(a.cxml).not.toBe(b.cxml);
  });

  it('rejects a tampered ciphertext via the MAC', () => {
    const customer = generateCustomerKeyPair();
    const sealed = encryptCustomerReceipt('hello', customer.publicKey);
    const bytes = Buffer.from(sealed.cxml, 'base64');
    bytes[0] ^= 0xff;
    const tampered = { ...sealed, cxml: bytes.toString('base64') };
    expect(() => decryptCustomerReceipt(tampered, customer.privateKey)).toThrow(/MAC/);
  });

  it('fails for the wrong customer key', () => {
    const customer = generateCustomerKeyPair();
    const other = generateCustomerKeyPair();
    const sealed = encryptCustomerReceipt('hello', customer.publicKey);
    expect(() => decryptCustomerReceipt(sealed, other.privateKey)).toThrow();
  });
});
