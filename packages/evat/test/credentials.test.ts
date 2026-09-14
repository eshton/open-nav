import { describe, expect, it } from 'vitest';
import { NavValidationError } from '@open-nav/core';
import { assertEvatCredentials } from '../src/credentials.js';

const valid = {
  login: 'tech-user',
  password: 'pw',
  signKey: 'sign-key',
  taxNumber: '12345678',
};

describe('assertEvatCredentials', () => {
  it('accepts complete credentials', () => {
    expect(() => assertEvatCredentials(valid)).not.toThrow();
  });

  it('rejects each missing required field', () => {
    for (const field of ['login', 'password', 'signKey', 'taxNumber'] as const) {
      expect(() => assertEvatCredentials({ ...valid, [field]: '' })).toThrow(NavValidationError);
    }
  });

  it('rejects a blank (whitespace) field', () => {
    expect(() => assertEvatCredentials({ ...valid, login: '   ' })).toThrow(NavValidationError);
  });

  it('rejects a tax number that is not the 8-digit core', () => {
    try {
      assertEvatCredentials({ ...valid, taxNumber: '12345678-2-41' });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(NavValidationError);
      expect(
        (error as NavValidationError).issues.some((i) => i.code === 'INVALID_TAX_NUMBER'),
      ).toBe(true);
    }
  });
});
