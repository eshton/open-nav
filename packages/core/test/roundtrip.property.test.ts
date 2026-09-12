import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  buildInvoice,
  parseDocument,
  serializeDocument,
  type BuildInvoiceInput,
} from '../src/index.js';

/**
 * Property-based XML round trip.
 *
 * The sample suite round-trips NAV's 41 fixed documents; this generates varied
 * invoices with buildInvoice — different parties, line counts, currencies and
 * rates, plus text that needs XML escaping — and asserts serialize -> parse
 * returns exactly what went in, for any of them.
 */

// A charset that includes the five XML-significant characters and accented
// Hungarian letters, so escaping is exercised. No whitespace, to avoid a
// round-trip difference from insignificant-whitespace handling rather than a
// real bug.
const textChar = fc.constantFrom(...'abcXYZ0123&<>"\'áÉűŐ-.'.split(''));
const textArb = fc.array(textChar, { minLength: 1, maxLength: 24 }).map((chars) => chars.join(''));

const taxNumberArb = fc.integer({ min: 10_000_000, max: 99_999_999 }).map(String);

const addressArb = fc.record({
  postalCode: fc.integer({ min: 1000, max: 9999 }).map(String),
  city: textArb,
  streetName: textArb,
  publicPlaceCategory: fc.constantFrom('utca', 'út', 'tér', 'sugárút'),
  number: fc.integer({ min: 1, max: 999 }).map(String),
});

const lineArb = fc.record({
  description: textArb,
  quantity: fc.integer({ min: 1, max: 100_000 }),
  unitPrice: fc.integer({ min: 1, max: 1_000_000 }),
  vatPercentage: fc.constantFrom(0, 0.05, 0.18, 0.27),
  nature: fc.constantFrom('PRODUCT' as const, 'SERVICE' as const, 'OTHER' as const),
});

const inputArb: fc.Arbitrary<BuildInvoiceInput> = fc
  .record({
    invoiceNumber: textArb,
    issueDate: fc.constant('2026-03-01'),
    currency: fc.constantFrom('HUF', 'EUR', 'USD'),
    rate: fc.integer({ min: 1, max: 500 }),
    supplier: fc.record({ name: textArb, taxNumber: taxNumberArb, address: addressArb }),
    customer: fc.record({ name: textArb, taxNumber: taxNumberArb, address: addressArb }),
    lines: fc.array(lineArb, { minLength: 1, maxLength: 5 }),
  })
  .map(({ currency, rate, ...rest }) => ({
    ...rest,
    currency,
    ...(currency === 'HUF' ? {} : { exchangeRate: rate }),
  }));

describe('InvoiceData XML round trip (property based)', () => {
  it('serialises and parses back to an equal document for any built invoice', () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const built = buildInvoice(input);
        const xml = serializeDocument('InvoiceData', built);
        expect(parseDocument(xml).value).toEqual(built);
      }),
    );
  });
});
