import { describe, expect, it } from 'vitest';
import { assertSoftwareId, isValidSoftwareId, softwareId } from '../src/software.js';
import { NavValidationError } from '../src/errors.js';

describe('softwareId', () => {
  it('builds a tax-number-prefixed id', () => {
    expect(softwareId('27990423', '-SZAMLALI1')).toBe('27990423-SZAMLALI1');
  });

  it('takes the 8-digit core from an 11-digit tax number', () => {
    expect(softwareId('12345678-2-41', '-SZAMLALI1')).toBe('12345678-SZAMLALI1');
  });

  it('uppercases the suffix', () => {
    expect(softwareId('27990423', '-szamlali1')).toBe('27990423-SZAMLALI1');
  });

  it('rejects a result that is not exactly 18 characters', () => {
    expect(() => softwareId('27990423', '-SZAMLALI001')).toThrowError(/18 characters/); // 20
    expect(() => softwareId('27990423', 'SHORT')).toThrowError(NavValidationError); // 13
  });
});

describe('isValidSoftwareId / assertSoftwareId', () => {
  it('accepts a valid id', () => {
    expect(isValidSoftwareId('27990423-SZAMLALI1')).toBe(true);
    expect(() => assertSoftwareId('27990423-SZAMLALI1')).not.toThrow();
  });

  it('rejects wrong length or charset', () => {
    expect(isValidSoftwareId('27990423-SZAMLALI001')).toBe(false); // 20, too long
    expect(isValidSoftwareId('OPENNAV000000001')).toBe(false); // 16, too short
    expect(isValidSoftwareId('27990423-szamlali1')).toBe(false); // lowercase
    expect(isValidSoftwareId('27990423 SZAMLALI1')).toBe(false); // space
    expect(() => assertSoftwareId('bad')).toThrowError(NavValidationError);
  });
});
