import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildInvoice,
  checkInvoiceSummary,
  computeInvoiceSummary,
  parseDocument,
  type InvoiceData,
  type InvoiceType,
} from '../src/index.js';

/**
 * Tests aimed at the mutation survivors in money/summary.ts: the simplified
 * branch, the amount/HUF distinction, and the mismatch-detection conditionals —
 * paths the sample-based suite runs but does not pin tightly enough to notice
 * if they broke.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const sample = (name: string): InvoiceType =>
  (
    parseDocument(readFileSync(join(REPO_ROOT, 'conformance', 'data-samples', name), 'utf8'))
      .value as InvoiceData
  ).invoiceMain.invoice!;

const normalInvoice = (): InvoiceType =>
  buildInvoice({
    invoiceNumber: 'M-1',
    issueDate: '2026-03-01',
    supplier: {
      name: 'S',
      taxNumber: '11111111',
      address: {
        postalCode: '1011',
        city: 'B',
        streetName: 'F',
        publicPlaceCategory: 'utca',
        number: '1',
      },
    },
    customer: {
      name: 'C',
      taxNumber: '22222222',
      address: {
        postalCode: '7600',
        city: 'P',
        streetName: 'R',
        publicPlaceCategory: 'út',
        number: '2',
      },
    },
    lines: [{ description: 'x', quantity: 10, unitPrice: 1000, vatPercentage: 0.27 }],
  }).invoiceMain.invoice!;

describe('summary — simplified branch', () => {
  it('summarises a simplified invoice, not as a normal one', () => {
    const summary = computeInvoiceSummary(sample('belfoldi-egyszerusitett-szamla.xml'));
    expect(summary.summarySimplified).toBeDefined();
    expect(summary.summaryNormal).toBeUndefined();
    expect(summary.summarySimplified?.[0]?.vatContentGrossAmount).toBe('24000.00');
  });

  it('summarises a normal invoice, not as a simplified one', () => {
    const summary = computeInvoiceSummary(sample('belfoldi-termekertekesites.xml'));
    expect(summary.summaryNormal).toBeDefined();
    expect(summary.summarySimplified).toBeUndefined();
  });
});

describe('summary — currency vs HUF', () => {
  it('keeps the HUF twins distinct from the currency amounts', () => {
    const invoice = buildInvoice({
      invoiceNumber: 'EUR-1',
      issueDate: '2026-03-01',
      currency: 'EUR',
      exchangeRate: 400,
      supplier: {
        name: 'S',
        taxNumber: '11111111',
        address: {
          postalCode: '1011',
          city: 'B',
          streetName: 'F',
          publicPlaceCategory: 'utca',
          number: '1',
        },
      },
      customer: {
        name: 'C',
        taxNumber: '22222222',
        address: {
          postalCode: '7600',
          city: 'P',
          streetName: 'R',
          publicPlaceCategory: 'út',
          number: '2',
        },
      },
      lines: [{ description: 'x', quantity: 1, unitPrice: 100, vatPercentage: 0.27 }],
    }).invoiceMain.invoice!;
    const normal = invoice.invoiceSummary.summaryNormal!;

    expect(normal.invoiceNetAmount).toBe('100.00');
    expect(normal.invoiceNetAmountHUF).toBe('40000.00');
    expect(normal.invoiceVatAmount).toBe('27.00');
    expect(normal.invoiceVatAmountHUF).toBe('10800.00');
    expect(invoice.invoiceSummary.summaryGrossData?.invoiceGrossAmount).toBe('127.00');
    expect(invoice.invoiceSummary.summaryGrossData?.invoiceGrossAmountHUF).toBe('50800.00');
  });
});

describe('summary — mismatch detection', () => {
  it('flags a wrong stated net amount, with its path', () => {
    const invoice = normalInvoice();
    invoice.invoiceSummary.summaryNormal!.invoiceNetAmount = '999999.00';
    const issues = checkInvoiceSummary(invoice);
    expect(issues).toContainEqual(
      expect.objectContaining({
        path: 'invoiceSummary.summaryNormal.invoiceNetAmount',
        code: 'SUMMARY_MISMATCH',
      }),
    );
  });

  it('flags a wrong stated gross amount', () => {
    const invoice = normalInvoice();
    invoice.invoiceSummary.summaryGrossData!.invoiceGrossAmount = '0.00';
    const issues = checkInvoiceSummary(invoice);
    expect(issues.some((issue) => issue.path.endsWith('invoiceGrossAmount'))).toBe(true);
  });

  it('flags a VAT-rate entry count that disagrees with the lines', () => {
    const invoice = normalInvoice();
    const byRate = invoice.invoiceSummary.summaryNormal!.summaryByVatRate;
    byRate.push({ ...byRate[0]!, vatRate: { vatPercentage: '0.05' } });
    const issues = checkInvoiceSummary(invoice);
    expect(issues.some((issue) => issue.code === 'SUMMARY_VAT_RATE_COUNT')).toBe(true);
  });

  it('accepts a correct summary', () => {
    expect(checkInvoiceSummary(normalInvoice())).toEqual([]);
  });
});
