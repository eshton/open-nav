import { describe, expect, it } from 'vitest';
import { TAX_CODES, TAX_CODES_BY_CODE, TAX_CODE_CATALOG_VERSION, taxCode } from '../src/index.js';

describe('tax-code catalogue', () => {
  it('exposes the versioned catalogue', () => {
    expect(TAX_CODE_CATALOG_VERSION).toBe('2026-09-04');
    expect(TAX_CODES.length).toBeGreaterThan(200);
  });

  it('every entry has the required fields', () => {
    for (const entry of TAX_CODES) {
      expect(entry.code).toBeTruthy();
      expect(entry.speakingCode).toBeTruthy();
      expect(entry.description).toBeTruthy();
    }
  });

  it('looks a code up by its exact string', () => {
    const first = TAX_CODES[0]!;
    expect(taxCode(first.code)).toEqual(first);
    expect(TAX_CODES_BY_CODE.get(first.code)).toEqual(first);
    expect(taxCode('NOT_A_CODE')).toBeUndefined();
  });

  it('maps codes to VAT-return rows (e.g. MP01)', () => {
    const mp01 = taxCode('MP01');
    expect(mp01?.speakingCode).toBe('F01');
    expect(mp01?.payableMainRow1).toBeTruthy();
  });
});
