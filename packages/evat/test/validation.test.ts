import { describe, expect, it } from 'vitest';
import { validateDeclaration } from '../src/validation.js';
import type { VatDeclarationData } from '../src/generated/types.js';

describe('validateDeclaration', () => {
  it('flags a declaration missing mandatory content', () => {
    const report = validateDeclaration({} as VatDeclarationData);
    expect(report.valid).toBe(false);
    expect(report.errors.some((i) => i.code === 'MANDATORY_CONTENT_MISSING')).toBe(true);
    // Findings carry NAV's own fault code/description.
    expect(report.errors.every((i) => i.origin === 'nav')).toBe(true);
  });

  it('flags an unknown element as a schema violation', () => {
    const report = validateDeclaration({ nonsense: 1 } as unknown as VatDeclarationData);
    expect(report.errors.some((i) => i.code === 'SCHEMA_VIOLATION')).toBe(true);
  });
});
