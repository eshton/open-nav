import { describe, expect, it } from 'vitest';
import { NavValidationError } from '../src/errors.js';
import { createXmlCodec } from '../src/xml/codec.js';

// A minimal schema with one integer, one decimal and one string field, to
// exercise formatPrimitive's number/string hardening directly.
const codec = createXmlCodec({
  types: {
    'x:Doc': {
      kind: 'complex',
      name: 'Doc',
      ns: 'x',
      tsName: 'Doc',
      content: 'element',
      fields: [
        { name: 'i', ns: 'x', type: 'xs:integer' },
        { name: 'd', ns: 'x', type: 'xs:decimal' },
        { name: 's', ns: 'x', type: 'xs:string' },
      ],
    },
  },
  roots: { Doc: { name: 'Doc', ns: 'x', type: 'x:Doc' } },
  namespaceUris: { x: 'urn:x' },
  xsPrimitives: { 'xs:integer': 'integer', 'xs:decimal': 'decimal', 'xs:string': 'string' },
});

const ok = { i: 5, d: '1.50', s: 'plain' };
const serialize = (v: unknown): string => codec.serializeDocument('Doc', v);

function issueCodes(run: () => unknown): string[] {
  try {
    run();
    return [];
  } catch (error) {
    return error instanceof NavValidationError
      ? error.issues.map((i) => i.code)
      : ['NOT_VALIDATION'];
  }
}

describe('codec formatPrimitive hardening', () => {
  it('serializes clean values', () => {
    expect(serialize(ok)).toContain('<i>5</i>');
    expect(serialize(ok)).toContain('<d>1.50</d>');
  });

  it('rejects an integer beyond the safe range (would render as 1e+21)', () => {
    expect(issueCodes(() => serialize({ ...ok, i: 1e21 }))).toContain('EXPECTED_INTEGER');
  });

  it('rejects a decimal that renders in exponential notation', () => {
    expect(issueCodes(() => serialize({ ...ok, d: 1e-7 }))).toContain('EXPECTED_DECIMAL');
  });

  it('accepts a plain finite decimal number', () => {
    expect(serialize({ ...ok, d: 1.5 })).toContain('<d>1.5</d>');
  });

  it('rejects a string with an XML-illegal control character', () => {
    expect(issueCodes(() => serialize({ ...ok, s: 'bad\u0000here' }))).toContain(
      'INVALID_XML_CHARACTER',
    );
    expect(issueCodes(() => serialize({ ...ok, s: 'bell\u0007' }))).toContain(
      'INVALID_XML_CHARACTER',
    );
  });

  it('allows tab, newline and CR in a string', () => {
    expect(() => serialize({ ...ok, s: 'a\tb\nc\rd' })).not.toThrow();
  });
});
