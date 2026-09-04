import { describe, expect, it } from 'vitest';
import {
  isValidCountyCode,
  isValidTaxpayerId,
  isValidVatCode,
  parseTaxNumber,
  taxpayerIdCheckDigit,
} from '../src/validation/tax-number.js';

describe('taxpayerId check digit', () => {
  it('accepts the real tax numbers used in NAV documents', () => {
    // Confirms the weighting: 9,7,3,1,9,7,3 over the first seven digits.
    for (const taxpayerId of ['99999999', '99887764', '11111111']) {
      expect(isValidTaxpayerId(taxpayerId), taxpayerId).toBe(true);
    }
  });

  it('rejects the placeholder numbers in NAV samples', () => {
    // Evidence that NAV validates against its registry, not arithmetically:
    // these appear in published samples yet fail the check digit, which is
    // why the validator reports this as a warning.
    for (const taxpayerId of ['98765432', '87654321']) {
      expect(isValidTaxpayerId(taxpayerId), taxpayerId).toBe(false);
    }
  });

  it('computes the check digit that makes a number valid', () => {
    for (const prefix of ['9999999', '9988776', '1111111', '1234567', '0000000']) {
      const complete = `${prefix}${taxpayerIdCheckDigit(prefix)}`;
      expect(isValidTaxpayerId(complete), complete).toBe(true);
    }
  });

  it('rejects every wrong check digit for a given prefix', () => {
    const prefix = '1234567';
    const correct = taxpayerIdCheckDigit(prefix);
    for (let digit = 0; digit <= 9; digit += 1) {
      expect(isValidTaxpayerId(`${prefix}${digit}`), `${prefix}${digit}`).toBe(digit === correct);
    }
  });

  it('detects a single digit typo', () => {
    // Weighted checksums catch any single wrong digit.
    const valid = '99887764';
    let caught = 0;
    let mutations = 0;
    for (let position = 0; position < 8; position += 1) {
      for (let digit = 0; digit <= 9; digit += 1) {
        if (Number(valid[position]) === digit) continue;
        mutations += 1;
        const mutated = `${valid.slice(0, position)}${digit}${valid.slice(position + 1)}`;
        if (!isValidTaxpayerId(mutated)) caught += 1;
      }
    }
    expect(mutations).toBe(72);
    expect(caught).toBe(72);
  });

  it('rejects anything that is not eight digits', () => {
    for (const bad of ['', '1234567', '123456789', '1234567a', ' 9999999 9', '99999999 ']) {
      expect(isValidTaxpayerId(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('refuses to compute a check digit for a bad prefix', () => {
    expect(() => taxpayerIdCheckDigit('123')).toThrowError(/seven digits/);
  });
});

describe('vatCode', () => {
  it('accepts 1 to 5 and nothing else', () => {
    for (const code of ['1', '2', '3', '4', '5']) expect(isValidVatCode(code)).toBe(true);
    for (const code of ['0', '6', '9', '', '12', 'a']) {
      expect(isValidVatCode(code), JSON.stringify(code)).toBe(false);
    }
  });
});

describe('countyCode', () => {
  it('accepts the codes NAV issues, including those in its samples', () => {
    for (const code of ['02', '41', '20', '22', '44', '51']) {
      expect(isValidCountyCode(code), code).toBe(true);
    }
  });

  it('rejects codes outside the issued set', () => {
    for (const code of ['00', '01', '21', '45', '50', '52', '99', '4', 'ab']) {
      expect(isValidCountyCode(code), code).toBe(false);
    }
  });
});

describe('parseTaxNumber', () => {
  it('splits the written forms of an eleven digit number', () => {
    const expected = { taxpayerId: '99887764', vatCode: '2', countyCode: '02' };
    for (const input of ['99887764-2-02', '99887764 2 02', '99887764202', ' 99887764-2-02 ']) {
      expect(parseTaxNumber(input), input).toEqual(expected);
    }
  });

  it('accepts a bare core number', () => {
    expect(parseTaxNumber('99887764')).toEqual({ taxpayerId: '99887764' });
  });

  it('rejects lengths that are neither 8 nor 11 digits', () => {
    for (const bad of ['1234567', '123456789', '1234567890', '123456789012', 'abcdefgh']) {
      expect(() => parseTaxNumber(bad), bad).toThrowError(/8 or 11 digit/);
    }
  });
});
