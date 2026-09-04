import { describe, expect, it } from 'vitest';
import {
  checkDocumentSummaries,
  checkInvoiceSummary,
  computeInvoiceSummary,
  vatRateKey,
} from '../src/money/summary.js';
import type { InvoiceData, InvoiceType } from '../src/generated/types.js';
import { parseDocument } from '../src/xml/read.js';
import { loadFixtures } from './fixtures.js';

/**
 * Summaries checked against NAV's own invoices.
 *
 * Six of the thirty published samples do not add up, and each is contradicted
 * by other figures in the same document — so these are errors in NAV's
 * examples, not in the rules below. They are listed explicitly rather than
 * excluded silently: if a future schema refresh corrects one upstream, this
 * table fails and we find out.
 */
const KNOWN_UPSTREAM_ERRORS: Record<string, { paths: string[]; contradiction: string }> = {
  'belfoldi-ertekesites-tobb-afa-tipus.xml': {
    paths: [
      'invoiceSummary.summaryGrossData.invoiceGrossAmount',
      'invoiceSummary.summaryGrossData.invoiceGrossAmountHUF',
    ],
    contradiction:
      'states gross 3263000.00, but its own net 2980000.00 plus VAT 283600.00 is 3263600.00',
  },
  'gyujtoszamla-1.xml': {
    paths: ['invoiceSummary.summaryNormal.summaryByVatRate.1.vatRateVatData.vatRateVatAmount'],
    contradiction:
      'per-rate VAT of 60000.00 + 1304000.00 is 1364000.00, but its own invoiceVatAmount is 1364640.00',
  },
  'harmadik-orszagbeli-devizas-szamla.xml': {
    paths: ['invoiceSummary.summaryGrossData.invoiceGrossAmount'],
    contradiction:
      'states gross 19120.40, but net 19120.00 with 0.00 VAT, and its own vatRateGrossAmount, are 19120.00',
  },
  'tagorszagi-devizas-szamla.xml': {
    paths: ['invoiceSummary.summaryGrossData.invoiceGrossAmount'],
    contradiction: 'same 0.40 discrepancy as the third-country sample it was copied from',
  },
  'termekdijas-szamla.xml': {
    paths: [
      'invoiceSummary.summaryNormal.invoiceVatAmount',
      'invoiceSummary.summaryNormal.invoiceVatAmountHUF',
    ],
    contradiction:
      'states invoiceVatAmount 280000.00, but its lines, its vatRateVatAmount and its gross total all say 280800.00',
  },
  'uj-kozlekedesi-eszkoz-export.xml': {
    paths: ['invoiceSummary.summaryGrossData.invoiceGrossAmount'],
    contradiction:
      'states gross 8000.40, but net 8000.00 with 0.00 VAT, and its own vatRateGrossAmount, are 8000.00',
  },
};

const fixtures = loadFixtures('data-samples').map((fixture) => ({
  ...fixture,
  document: parseDocument(fixture.xml).value as InvoiceData,
}));

const invoicesOf = (document: InvoiceData): InvoiceType[] =>
  document.invoiceMain.invoice
    ? [document.invoiceMain.invoice]
    : (document.invoiceMain.batchInvoice ?? []).map((entry) => entry.invoice);

describe('summary reconciliation against NAV invoices', () => {
  const expectedClean = fixtures.length - Object.keys(KNOWN_UPSTREAM_ERRORS).length;

  it(`reconciles ${expectedClean} of the ${fixtures.length} published invoices`, () => {
    const clean = fixtures.filter(
      (fixture) => checkDocumentSummaries(fixture.document).length === 0,
    );
    expect(clean).toHaveLength(expectedClean);
  });

  for (const fixture of fixtures) {
    const known = KNOWN_UPSTREAM_ERRORS[fixture.name];

    if (!known) {
      it(`reconciles ${fixture.name}`, () => {
        expect(checkDocumentSummaries(fixture.document)).toEqual([]);
      });
      continue;
    }

    it(`reports only the documented upstream error in ${fixture.name}`, () => {
      const issues = checkDocumentSummaries(fixture.document);
      expect(issues.map((issue) => issue.path).sort()).toEqual([...known.paths].sort());
      expect(issues.every((issue) => issue.code === 'SUMMARY_MISMATCH')).toBe(true);
    });
  }
});

describe('computeInvoiceSummary', () => {
  it("reproduces NAV's own summary figures where the sample is self-consistent", () => {
    for (const fixture of fixtures) {
      if (KNOWN_UPSTREAM_ERRORS[fixture.name]) continue;
      for (const invoice of invoicesOf(fixture.document)) {
        const computed = computeInvoiceSummary(invoice);
        const stated = invoice.invoiceSummary;
        if (!stated.summaryNormal || !computed.summaryNormal) continue;

        expect(computed.summaryNormal.invoiceNetAmount, fixture.name).toBe(
          normalise(stated.summaryNormal.invoiceNetAmount),
        );
        expect(computed.summaryNormal.invoiceVatAmount, fixture.name).toBe(
          normalise(stated.summaryNormal.invoiceVatAmount),
        );
      }
    }
  });

  it('derives line VAT from the rate when lineVatData is absent', () => {
    // NAV's advance invoices state a net amount and a rate but no VAT.
    const advance = fixtures.find((fixture) => fixture.name === 'belfoldi-elolegszamla.xml')!;
    const invoice = invoicesOf(advance.document)[0]!;
    expect(invoice.invoiceLines?.line[0]?.lineAmountsNormal?.lineVatData).toBeUndefined();
    expect(computeInvoiceSummary(invoice).summaryNormal?.invoiceVatAmount).toBe('135000.00');
  });

  it('skips reconciliation for a modification document whose lines carry no amounts', () => {
    const modification = fixtures.find((fixture) => fixture.name === 'teteladatok-modositasa.xml')!;
    const invoice = invoicesOf(modification.document)[0]!;
    expect(invoice.invoiceLines?.line[0]?.lineAmountsNormal).toBeUndefined();
    expect(checkInvoiceSummary(invoice)).toEqual([]);
  });
});

describe('vatRateKey', () => {
  it('treats numerically equal percentages as the same rate', () => {
    expect(vatRateKey({ vatPercentage: '0.27' })).toBe(vatRateKey({ vatPercentage: '0.2700' }));
  });

  it('distinguishes different percentages', () => {
    expect(vatRateKey({ vatPercentage: '0.27' })).not.toBe(vatRateKey({ vatPercentage: '0.05' }));
  });

  it('identifies an exemption by its case, not its free-text reason', () => {
    expect(vatRateKey({ vatExemption: { case: 'KBAUK', reason: 'Áfa tv. 89. §' } })).toBe(
      vatRateKey({ vatExemption: { case: 'KBAUK', reason: 'Adómentes értékesítés' } }),
    );
  });

  it('distinguishes different exemption cases', () => {
    expect(vatRateKey({ vatExemption: { case: 'KBAUK', reason: 'x' } })).not.toBe(
      vatRateKey({ vatExemption: { case: 'EAM', reason: 'x' } }),
    );
  });

  it('distinguishes an exemption from a zero percentage', () => {
    expect(vatRateKey({ vatPercentage: '0' })).not.toBe(
      vatRateKey({ vatExemption: { case: 'EAM', reason: 'x' } }),
    );
  });
});

/** NAV writes the same amount as both `500000` and `500000.00`. */
function normalise(amount: string): string {
  return amount.includes('.') ? amount : `${amount}.00`;
}
