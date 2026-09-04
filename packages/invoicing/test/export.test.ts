import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseDocument, type InvoiceData } from '@open-nav/core';
import { compareInvoiceNumbersNaturally, createDataExport, isSelected } from '../src/export.js';
import { allSamples, sample } from './fixtures.js';

/**
 * The data export required of invoicing programs by decree
 * 23/2014. (VI. 30.) NGM, produced in the structure section 13/A(1) permits.
 */

function withNumber(number: string, issueDate = '2024-01-15'): InvoiceData {
  const document = sample('belfoldi-termekertekesites.xml');
  document.invoiceNumber = number;
  document.invoiceIssueDate = issueDate;
  return document;
}

describe('compareInvoiceNumbersNaturally', () => {
  it('orders digit runs as numbers, not as text', () => {
    // Plain text ordering puts 2024/10 before 2024/9 and would silently drop
    // invoices from the middle of a requested range.
    expect(compareInvoiceNumbersNaturally('2024/9', '2024/10')).toBe(-1);
    expect('2024/9' < '2024/10').toBe(false);
  });

  it('sorts a realistic sequence correctly', () => {
    const numbers = ['A-10', 'A-2', 'A-1', 'A-100', 'A-20'];
    expect([...numbers].sort(compareInvoiceNumbersNaturally)).toEqual([
      'A-1',
      'A-2',
      'A-10',
      'A-20',
      'A-100',
    ]);
  });

  it('handles numbers longer than a safe integer', () => {
    expect(
      compareInvoiceNumbersNaturally('INV-99999999999999999998', 'INV-99999999999999999999'),
    ).toBe(-1);
  });

  it('treats equal numbers as equal, however they are padded', () => {
    expect(compareInvoiceNumbersNaturally('2024/007', '2024/7')).toBe(0);
  });
});

describe('selection', () => {
  const invoice = withNumber('2024/5', '2024-03-10');

  it('selects everything when nothing is asked for', () => {
    expect(isSelected(invoice, {})).toBe(true);
  });

  it('filters by issue date, inclusively at both ends', () => {
    expect(isSelected(invoice, { issueDateFrom: '2024-03-10' })).toBe(true);
    expect(isSelected(invoice, { issueDateTo: '2024-03-10' })).toBe(true);
    expect(isSelected(invoice, { issueDateFrom: '2024-03-11' })).toBe(false);
    expect(isSelected(invoice, { issueDateTo: '2024-03-09' })).toBe(false);
  });

  it('filters by invoice number range using natural ordering', () => {
    expect(isSelected(invoice, { invoiceNumberFrom: '2024/1', invoiceNumberTo: '2024/10' })).toBe(
      true,
    );
    expect(isSelected(invoice, { invoiceNumberFrom: '2024/6' })).toBe(false);
  });

  it('accepts a caller-supplied ordering', () => {
    const reversed = (left: string, right: string): number =>
      -compareInvoiceNumbersNaturally(left, right);
    expect(
      isSelected(invoice, { invoiceNumberFrom: '2024/6', compareInvoiceNumbers: reversed }),
    ).toBe(true);
  });
});

describe('createDataExport', () => {
  const now = () => new Date('2026-03-01T12:00:00.000Z');

  it('writes one XML per invoice plus a manifest', () => {
    const result = createDataExport([withNumber('2024/1'), withNumber('2024/2')], { now });
    expect(result.files.map((file) => file.name)).toEqual([
      'invoices/2024-1.xml',
      'invoices/2024-2.xml',
      'manifest.json',
    ]);
    expect(result.manifest.invoiceCount).toBe(2);
  });

  it('produces XML that parses back to the invoice it came from', () => {
    const invoice = withNumber('2024/1');
    const result = createDataExport([invoice], { now });
    const file = result.files.find((entry) => entry.name.endsWith('.xml'))!;
    expect(parseDocument(file.contents).value).toEqual(invoice);
  });

  it('records the structure used and the provision that permits it', () => {
    const result = createDataExport([withNumber('2024/1')], { now });
    expect(result.manifest.structure.schema).toBe('invoiceData.xsd');
    expect(result.manifest.structure.basis).toContain('13/A');
  });

  it('checksums every exported file so the export can be shown unaltered', () => {
    const result = createDataExport([withNumber('2024/1')], { now });
    const file = result.files.find((entry) => entry.name.endsWith('.xml'))!;
    const expected = createHash('sha256').update(file.contents, 'utf8').digest('hex');
    expect(result.manifest.invoices[0]?.sha256).toBe(expected);
  });

  it('sorts the export by invoice number, naturally', () => {
    const result = createDataExport(
      [withNumber('2024/10'), withNumber('2024/2'), withNumber('2024/1')],
      { now },
    );
    expect(result.manifest.invoices.map((entry) => entry.invoiceNumber)).toEqual([
      '2024/1',
      '2024/2',
      '2024/10',
    ]);
  });

  it('exports only the requested date range', () => {
    const result = createDataExport(
      [
        withNumber('2024/1', '2024-01-31'),
        withNumber('2024/2', '2024-02-01'),
        withNumber('2024/3', '2024-03-01'),
      ],
      { issueDateFrom: '2024-02-01', issueDateTo: '2024-02-29', now },
    );
    expect(result.manifest.invoices.map((entry) => entry.invoiceNumber)).toEqual(['2024/2']);
    expect(result.manifest.selection).toEqual({
      issueDateFrom: '2024-02-01',
      issueDateTo: '2024-02-29',
    });
  });

  it('turns an invoice number into a usable file name', () => {
    const result = createDataExport([withNumber('2024/000123')], { now });
    expect(result.files[0]?.name).toBe('invoices/2024-000123.xml');
  });

  it('keeps two invoices apart when their numbers sanitise the same', () => {
    const result = createDataExport([withNumber('2024/1'), withNumber('2024-1')], { now });
    const names = result.files.filter((file) => file.name.endsWith('.xml')).map((f) => f.name);
    expect(new Set(names).size).toBe(2);
  });

  it('produces an empty but well-formed export when nothing matches', () => {
    const result = createDataExport([withNumber('2024/1', '2024-01-01')], {
      issueDateFrom: '2030-01-01',
      now,
    });
    expect(result.manifest.invoiceCount).toBe(0);
    expect(result.files).toHaveLength(1);
    expect(JSON.parse(result.files[0]!.contents)).toMatchObject({ invoiceCount: 0 });
  });

  it('exports every published sample without failing', () => {
    const documents = allSamples().map((entry) => entry.document);
    const result = createDataExport(documents, { now });
    expect(result.manifest.invoiceCount).toBe(documents.length);
    for (const file of result.files) {
      if (file.name.endsWith('.xml')) expect(() => parseDocument(file.contents)).not.toThrow();
    }
  });
});
