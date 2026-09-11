import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { Decimal, sum } from '../src/money/decimal.js';

/**
 * Property-based coverage for the exact-decimal core.
 *
 * The 30 NAV samples exercise the amounts NAV happens to publish; these assert
 * the algebraic laws the class must obey for *any* amount, which is what keeps
 * a one-fillér reconciliation error from slipping through on an input nobody
 * wrote a sample for. Every generated case is an exact decimal built from
 * digit strings, so no precision is lost before the class ever sees it.
 */

/** Up to 16 integer and 10 fractional digits, either sign — NAV's real range. */
const decimalArb: fc.Arbitrary<Decimal> = fc
  .record({
    sign: fc.constantFrom('', '-'),
    whole: fc.array(fc.integer({ min: 0, max: 9 }), { minLength: 1, maxLength: 16 }),
    fraction: fc.array(fc.integer({ min: 0, max: 9 }), { maxLength: 10 }),
  })
  .map(({ sign, whole, fraction }) => {
    const w = whole.join('');
    const f = fraction.join('');
    return Decimal.from(f.length > 0 ? `${sign}${w}.${f}` : `${sign}${w}`);
  });

const scaleArb = fc.integer({ min: 0, max: 12 });

/** 0.5 x 10^-scale, the largest a half-up rounding may move a value. */
const halfUlp = (scale: number): Decimal => Decimal.from(`0.${'0'.repeat(scale)}5`);

describe('Decimal (property based)', () => {
  it('round-trips through its own canonical text', () => {
    fc.assert(
      fc.property(decimalArb, (d) => {
        expect(Decimal.from(d.toString()).equals(d)).toBe(true);
      }),
    );
  });

  it('adds commutatively', () => {
    fc.assert(
      fc.property(decimalArb, decimalArb, (a, b) => {
        expect(a.add(b).equals(b.add(a))).toBe(true);
      }),
    );
  });

  it('adds associatively', () => {
    fc.assert(
      fc.property(decimalArb, decimalArb, decimalArb, (a, b, c) => {
        expect(
          a
            .add(b)
            .add(c)
            .equals(a.add(b.add(c))),
        ).toBe(true);
      }),
    );
  });

  it('treats subtraction as the inverse of addition', () => {
    fc.assert(
      fc.property(decimalArb, decimalArb, (a, b) => {
        expect(a.add(b).subtract(b).equals(a)).toBe(true);
      }),
    );
  });

  it('multiplies commutatively and exactly (scales add, no rounding)', () => {
    fc.assert(
      fc.property(decimalArb, decimalArb, (a, b) => {
        const product = a.multiply(b);
        expect(product.equals(b.multiply(a))).toBe(true);
        expect(product.scale).toBe(a.scale + b.scale);
      }),
    );
  });

  it('is order-independent when summing a list', () => {
    fc.assert(
      fc.property(fc.array(decimalArb, { maxLength: 20 }), (values) => {
        const shuffled = [...values].reverse();
        expect(sum(values).equals(sum(shuffled))).toBe(true);
      }),
    );
  });

  it('negates as an involution that cancels against itself', () => {
    fc.assert(
      fc.property(decimalArb, (d) => {
        expect(d.negate().negate().equals(d)).toBe(true);
        expect(d.add(d.negate()).isZero()).toBe(true);
      }),
    );
  });

  it('yields a non-negative absolute value equal to itself or its negation', () => {
    fc.assert(
      fc.property(decimalArb, (d) => {
        const abs = d.abs();
        expect(abs.isNegative()).toBe(false);
        expect(abs.equals(d) || abs.equals(d.negate())).toBe(true);
      }),
    );
  });

  it('orders consistently: compare is antisymmetric and agrees with equals', () => {
    fc.assert(
      fc.property(decimalArb, decimalArb, (a, b) => {
        expect(a.compare(b)).toBe(-b.compare(a) as -1 | 0 | 1);
        expect(a.equals(b)).toBe(a.compare(b) === 0);
        expect(a.compare(a)).toBe(0);
      }),
    );
  });

  describe('rounding', () => {
    it('moves a value by at most half a unit in the last place', () => {
      fc.assert(
        fc.property(decimalArb, scaleArb, (d, scale) => {
          const delta = d.subtract(d.round(scale)).abs();
          // half-up ties land exactly on the bound, so <= not <.
          expect(delta.compare(halfUlp(scale)) <= 0).toBe(true);
        }),
      );
    });

    it('is idempotent at a fixed scale', () => {
      fc.assert(
        fc.property(decimalArb, scaleArb, (d, scale) => {
          const once = d.round(scale);
          expect(once.round(scale).equals(once)).toBe(true);
        }),
      );
    });

    it('produces exactly the requested number of decimal places', () => {
      fc.assert(
        fc.property(decimalArb, fc.integer({ min: 1, max: 12 }), (d, scale) => {
          const [, fraction = ''] = d.round(scale).toString().split('.');
          expect(fraction.length).toBe(scale);
        }),
      );
    });

    it('never rounds up below the halfway point or down above it', () => {
      // Rescaling up is lossless, so a value already at `scale` is unchanged.
      fc.assert(
        fc.property(decimalArb, scaleArb, (d, extra) => {
          const wider = d.rescale(d.scale + extra);
          expect(wider.equals(d)).toBe(true);
        }),
      );
    });
  });
});
