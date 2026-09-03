import { describe, expect, it } from 'vitest';
import { Decimal, sum } from '../src/money/decimal.js';
import { NavValidationError } from '../src/errors.js';

describe('Decimal', () => {
  it('parses and re-renders exactly', () => {
    for (const text of ['0', '-0.01', '1000000', '3000.00', '0.2700', '123456789012345.67']) {
      expect(Decimal.from(text).toString()).toBe(text);
    }
  });

  it('holds the full range NAV allows', () => {
    // MonetaryType permits 18 significant digits; scaled to fillér that is
    // beyond Number.MAX_SAFE_INTEGER, which is why these are not numbers.
    const big = '9999999999999999.99';
    expect(Decimal.from(big).toString()).toBe(big);
    expect(Decimal.from(big).totalDigits()).toBe(18);
    // The same value as a double cannot even round trip through its own text.
    expect(String(Number(big))).not.toBe(big);
    expect(Decimal.from(big).add('0.01').toString()).toBe('10000000000000000.00');
  });

  it('keeps QuantityType precision, which doubles cannot', () => {
    // QuantityType allows 10 decimal places.
    const quantity = '0.0000000001';
    expect(Decimal.from(quantity).toString()).toBe(quantity);
    expect(Decimal.from(quantity).multiply('3').toString()).toBe('0.0000000003');
  });

  it('adds without the floating point artefacts', () => {
    expect(Decimal.from('0.1').add('0.2').toString()).toBe('0.3');
    expect(0.1 + 0.2).not.toBe(0.3); // the reason this class exists
  });

  it('multiplies a net amount by a VAT rate exactly', () => {
    expect(Decimal.from('500000.00').multiply('0.27').round(2).toString()).toBe('135000.00');
    expect(Decimal.from('1234.56').multiply('0.27').toString()).toBe('333.3312');
    expect(Decimal.from('1234.56').multiply('0.27').round(2).toString()).toBe('333.33');
  });

  it('sums a list with no intermediate rounding', () => {
    const thirds = Array.from({ length: 3 }, () => '0.005');
    expect(sum(thirds).toString()).toBe('0.015');
    // Rounding each term first would give 0.03; rounding the total gives 0.02.
    expect(sum(thirds).round(2).toString()).toBe('0.02');
  });

  describe('rounding', () => {
    it('rounds half away from zero by default, as commercial practice does', () => {
      expect(Decimal.from('0.125').round(2).toString()).toBe('0.13');
      expect(Decimal.from('-0.125').round(2).toString()).toBe('-0.13');
      expect(Decimal.from('2.5').round(0).toString()).toBe('3');
      expect(Decimal.from('-2.5').round(0).toString()).toBe('-3');
    });

    it('supports banker’s rounding', () => {
      expect(Decimal.from('0.125').round(2, 'half-even').toString()).toBe('0.12');
      expect(Decimal.from('0.135').round(2, 'half-even').toString()).toBe('0.14');
      expect(Decimal.from('2.5').round(0, 'half-even').toString()).toBe('2');
      expect(Decimal.from('3.5').round(0, 'half-even').toString()).toBe('4');
    });

    it('supports truncation and rounding away from zero', () => {
      expect(Decimal.from('1.999').round(2, 'down').toString()).toBe('1.99');
      expect(Decimal.from('-1.991').round(2, 'down').toString()).toBe('-1.99');
      expect(Decimal.from('1.001').round(2, 'up').toString()).toBe('1.01');
      expect(Decimal.from('-1.001').round(2, 'up').toString()).toBe('-1.01');
    });

    it('leaves an already exact value alone', () => {
      expect(Decimal.from('1.50').round(2, 'up').toString()).toBe('1.50');
      expect(Decimal.from('1.5').round(1, 'up').toString()).toBe('1.5');
    });
  });

  describe('division', () => {
    it('requires an explicit scale, so precision is never decided silently', () => {
      expect(Decimal.from('1').divide('3', 4).toString()).toBe('0.3333');
      expect(Decimal.from('2').divide('3', 4).toString()).toBe('0.6667');
    });

    it('derives a net amount from a gross amount', () => {
      // Gross 127000 at 27% -> net 100000.
      expect(Decimal.from('127000').divide(Decimal.ONE.add('0.27'), 2).toString()).toBe(
        '100000.00',
      );
    });

    it('rejects division by zero', () => {
      expect(() => Decimal.from('1').divide('0', 2)).toThrowError(/divisor/);
    });
  });

  describe('comparison', () => {
    it('compares across different scales', () => {
      expect(Decimal.from('1.5').equals('1.50')).toBe(true);
      expect(Decimal.from('1.5').compare('1.50')).toBe(0);
      expect(Decimal.from('1.5').compare('1.51')).toBe(-1);
      expect(Decimal.from('1.52').compare('1.51')).toBe(1);
    });

    it('knows zero and sign', () => {
      expect(Decimal.from('-0.00').isZero()).toBe(true);
      expect(Decimal.from('-0.01').isNegative()).toBe(true);
      expect(Decimal.from('-1.5').abs().toString()).toBe('1.5');
      expect(Decimal.from('1.5').negate().toString()).toBe('-1.5');
    });
  });

  describe('construction', () => {
    it('accepts integers, bigints and Decimals', () => {
      expect(Decimal.from(42).toString()).toBe('42');
      expect(Decimal.from(10n ** 20n).toString()).toBe('100000000000000000000');
      expect(Decimal.from(Decimal.from('1.5')).toString()).toBe('1.5');
    });

    it('rejects values that are not decimals', () => {
      for (const bad of ['', 'abc', '1,5', '1.2.3', '1e5', Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(() => Decimal.from(bad as string), String(bad)).toThrowError(NavValidationError);
      }
    });

    it('serialises as a string in JSON, so it survives a round trip', () => {
      expect(JSON.stringify({ amount: Decimal.from('1.50') })).toBe('{"amount":"1.50"}');
    });
  });
});
