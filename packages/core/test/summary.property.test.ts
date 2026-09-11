import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { checkInvoiceSummary, computeInvoiceSummary } from '../src/money/summary.js';
import { Decimal, sum } from '../src/money/decimal.js';
import type { InvoiceType, LineType } from '../src/generated/types.js';

/**
 * Property-based coverage for VAT-rate summary reconciliation.
 *
 * The sample-based suite proves the rules against NAV's 30 invoices; these
 * assert the invariants that must hold for any set of lines. The central one:
 * the summary this library *computes* must be a summary this library
 * *accepts*. A drift between computeInvoiceSummary and checkInvoiceSummary — a
 * different rounding decision, a different grouping — would let the builder
 * emit an invoice NAV then rejects, the exact failure this project exists to
 * prevent.
 */

/** The forint VAT rates that appear across NAV's samples. */
const rateArb = fc.constantFrom('0', '0.05', '0.18', '0.27');

/** A positive monetary amount with two decimals, as fillér formatted to HUF. */
const amountArb = fc
  .integer({ min: 0, max: 5_000_000_00 })
  .map((filler) => `${Math.floor(filler / 100)}.${String(filler % 100).padStart(2, '0')}`);

/** A normal (non-simplified) HUF line: net + rate, VAT derived from the rate. */
const lineArb: fc.Arbitrary<LineType> = fc.record({ net: amountArb, rate: rateArb }).map(
  ({ net, rate }) =>
    ({
      lineAmountsNormal: {
        lineNetAmountData: { lineNetAmount: net, lineNetAmountHUF: net },
        lineVatRate: { vatPercentage: rate },
      },
    }) as unknown as LineType,
);

const invoiceOf = (lines: LineType[]): InvoiceType =>
  ({ invoiceLines: { line: lines } }) as unknown as InvoiceType;

describe('summary reconciliation (property based)', () => {
  it('accepts every summary it computes', () => {
    fc.assert(
      fc.property(fc.array(lineArb, { minLength: 1, maxLength: 30 }), (lines) => {
        const base = invoiceOf(lines);
        const invoice: InvoiceType = { ...base, invoiceSummary: computeInvoiceSummary(base) };
        expect(checkInvoiceSummary(invoice)).toEqual([]);
      }),
    );
  });

  it('nets to the rounded sum of the line net amounts', () => {
    fc.assert(
      fc.property(fc.array(lineArb, { minLength: 1, maxLength: 30 }), (lines) => {
        const summary = computeInvoiceSummary(invoiceOf(lines));
        const expected = sum(
          lines.map((line) => line.lineAmountsNormal!.lineNetAmountData.lineNetAmount),
        )
          .round(2)
          .toString();
        expect(summary.summaryNormal?.invoiceNetAmount).toBe(expected);
      }),
    );
  });

  it('grosses to net plus VAT', () => {
    fc.assert(
      fc.property(fc.array(lineArb, { minLength: 1, maxLength: 30 }), (lines) => {
        const summary = computeInvoiceSummary(invoiceOf(lines));
        const net = Decimal.from(summary.summaryNormal!.invoiceNetAmount);
        const vat = Decimal.from(summary.summaryNormal!.invoiceVatAmount);
        const gross = Decimal.from(summary.summaryGrossData!.invoiceGrossAmount);
        expect(gross.equals(net.add(vat))).toBe(true);
      }),
    );
  });

  it('emits one summary entry per distinct VAT rate on the lines', () => {
    fc.assert(
      fc.property(fc.array(lineArb, { minLength: 1, maxLength: 30 }), (lines) => {
        const distinctRates = new Set(
          lines.map((line) => line.lineAmountsNormal!.lineVatRate.vatPercentage),
        );
        const summary = computeInvoiceSummary(invoiceOf(lines));
        expect(summary.summaryNormal?.summaryByVatRate.length).toBe(distinctRates.size);
      }),
    );
  });
});
