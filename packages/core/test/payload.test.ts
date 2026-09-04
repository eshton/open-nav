import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { NavValidationError } from '../src/errors.js';
import { decodeInvoiceData, decodeToXml, encodeInvoiceData } from '../src/invoice/payload.js';
import { parseDocument } from '../src/xml/read.js';
import type { InvoiceData } from '../src/generated/types.js';
import { loadFixtures } from './fixtures.js';

const fixtures = loadFixtures('data-samples');

describe('invoice payload encoding', () => {
  it('round trips every official invoice, uncompressed', () => {
    for (const fixture of fixtures) {
      const invoice = parseDocument(fixture.xml).value as InvoiceData;
      expect(decodeInvoiceData(encodeInvoiceData(invoice)), fixture.name).toEqual(invoice);
    }
  });

  it('round trips every official invoice, gzipped', () => {
    for (const fixture of fixtures) {
      const invoice = parseDocument(fixture.xml).value as InvoiceData;
      const encoded = encodeInvoiceData(invoice, { compress: true });
      expect(decodeInvoiceData(encoded), fixture.name).toEqual(invoice);
    }
  });

  it('compression actually shrinks a realistic invoice', () => {
    const invoice = parseDocument(
      fixtures.find((fixture) => fixture.name === 'belfoldi-ertekesites-tobb-afa-tipus.xml')!.xml,
    ).value as InvoiceData;
    const plain = encodeInvoiceData(invoice).length;
    const gzipped = encodeInvoiceData(invoice, { compress: true }).length;
    expect(gzipped).toBeLessThan(plain / 2);
  });

  it('detects gzip from the payload, not only from the indicator', () => {
    const invoice = parseDocument(fixtures[0]!.xml).value as InvoiceData;
    const gzipped = encodeInvoiceData(invoice, { compress: true });
    // NAV's compressedContentIndicator describes the batch as submitted, so a
    // caller may pass nothing, or pass it wrongly. Both must still work.
    expect(decodeInvoiceData(gzipped)).toEqual(invoice);
    expect(decodeInvoiceData(gzipped, { compressed: true })).toEqual(invoice);
    expect(decodeInvoiceData(encodeInvoiceData(invoice), { compressed: false })).toEqual(invoice);
  });

  it('tolerates base64 wrapped across lines, as NAV samples are', () => {
    const invoice = parseDocument(fixtures[0]!.xml).value as InvoiceData;
    const wrapped = encodeInvoiceData(invoice).replace(/(.{60})/g, '$1\n\t');
    expect(decodeInvoiceData(wrapped)).toEqual(invoice);
  });

  it('explains a payload declared compressed that is not', () => {
    expect(() =>
      decodeToXml(Buffer.from('<a/>').toString('base64'), { compressed: true }),
    ).toThrowError(/gzip magic bytes/);
  });

  it('explains truncated gzip data', () => {
    const truncated = gzipSync(Buffer.from('<InvoiceData/>')).subarray(0, 8);
    expect(() => decodeToXml(truncated.toString('base64'))).toThrowError(NavValidationError);
  });

  it('rejects an empty payload', () => {
    expect(() => decodeToXml('')).toThrowError(/zero bytes/);
  });
});
