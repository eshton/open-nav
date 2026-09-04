import { describe, expect, it } from 'vitest';
import {
  formatAmount,
  formatDate,
  formatPercentage,
  formatTaxNumber,
  escapeHtml,
} from '../src/format.js';

/** Hungarian groups thousands with a non-breaking space. */
const NBSP = '\u00a0';

describe('formatAmount', () => {
  it('uses Hungarian grouping and decimal separators', () => {
    expect(formatAmount('1234567.89', 'hu')).toBe(`1${NBSP}234${NBSP}567,89`);
    expect(formatAmount('0.5', 'hu')).toBe('0,50');
    expect(formatAmount('-1000', 'hu')).toBe(`-1${NBSP}000,00`);
  });

  it('separates thousands with a non-breaking space, not a plain one', () => {
    expect(formatAmount('1000', 'hu')).not.toContain(' ');
    expect(formatAmount('1000', 'hu')).toContain(NBSP);
  });

  it('uses English separators when asked', () => {
    expect(formatAmount('1234567.89', 'en')).toBe('1,234,567.89');
  });

  it('formats without going through a JavaScript number', () => {
    // Beyond the safe integer range: a Number round trip would corrupt this.
    const huge = '9999999999999999.99';
    expect(formatAmount(huge, 'hu')).toBe(`9${NBSP}999${NBSP}999${NBSP}999${NBSP}999${NBSP}999,99`);
    expect(String(Number(huge))).not.toBe(huge);
  });

  it('honours a requested precision', () => {
    expect(formatAmount('2.5', 'hu', 0)).toBe('3');
    expect(formatAmount('1.23456', 'hu', 4)).toBe('1,2346');
  });
});

describe('formatPercentage', () => {
  it('renders a rate as a percentage', () => {
    expect(formatPercentage('0.27', 'hu')).toBe('27%');
    expect(formatPercentage('0.05', 'hu')).toBe('5%');
    expect(formatPercentage('0', 'hu')).toBe('0%');
  });

  it('keeps a fractional percentage and localises the separator', () => {
    expect(formatPercentage('0.075', 'hu')).toBe('7,5%');
    expect(formatPercentage('0.075', 'en')).toBe('7.5%');
  });

  it('drops trailing zeros from a padded rate', () => {
    expect(formatPercentage('0.2700', 'hu')).toBe('27%');
  });
});

describe('formatDate', () => {
  it('writes Hungarian dates with dots', () => {
    expect(formatDate('2021-05-15', 'hu')).toBe('2021. 05. 15.');
  });

  it('leaves ISO dates alone in English', () => {
    expect(formatDate('2021-05-15', 'en')).toBe('2021-05-15');
  });

  it('passes through anything that is not a plain date', () => {
    expect(formatDate('2021-05', 'hu')).toBe('2021-05');
  });
});

describe('formatTaxNumber', () => {
  it('joins the parts in the written form', () => {
    expect(formatTaxNumber({ taxpayerId: '99887764', vatCode: '2', countyCode: '02' })).toBe(
      '99887764-2-02',
    );
  });

  it('omits parts that are absent', () => {
    expect(formatTaxNumber({ taxpayerId: '99887764' })).toBe('99887764');
  });
});

describe('escapeHtml', () => {
  it('neutralises markup in invoice data', () => {
    expect(escapeHtml('<script>alert("x")</script> & co')).toBe(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; co',
    );
  });
});
