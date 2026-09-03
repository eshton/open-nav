import { describe, expect, it } from 'vitest';
import { parseDocument } from '../src/xml/read.js';
import { serializeDocument } from '../src/xml/write.js';
import { loadFixtures } from './fixtures.js';

/**
 * Guards the round trip test against becoming vacuous: if the comparison were
 * too lenient, these mutations would slip through unnoticed.
 */
describe('round trip comparison is actually sensitive', () => {
  const invoice = loadFixtures('data-samples').find(
    (fixture) => fixture.name === 'belfoldi-termekertekesites.xml',
  )!;

  it('detects a changed value', () => {
    const parsed = parseDocument(invoice.xml) as { root: string; value: Record<string, unknown> };
    const mutated = { ...parsed.value, invoiceNumber: 'MUTATED/000001' };
    expect(serializeDocument(parsed.root, mutated)).not.toBe(
      serializeDocument(parsed.root, parsed.value),
    );
  });

  it('rejects an unknown field rather than dropping it', () => {
    const parsed = parseDocument(invoice.xml) as { root: string; value: Record<string, unknown> };
    expect(() => serializeDocument(parsed.root, { ...parsed.value, notAThing: 'x' })).toThrowError(
      /notAThing/,
    );
  });

  it('rejects a missing required field rather than emitting it empty', () => {
    const parsed = parseDocument(invoice.xml) as { root: string; value: Record<string, unknown> };
    const { invoiceNumber, ...withoutNumber } = parsed.value;
    expect(invoiceNumber).toBeTruthy();
    expect(() => serializeDocument(parsed.root, withoutNumber)).toThrowError(
      /invoiceNumber.*required/s,
    );
  });

  it('rejects an unknown element when parsing', () => {
    const broken = invoice.xml.replace(
      '<invoiceNumber>',
      '<somethingElse>x</somethingElse><invoiceNumber>',
    );
    expect(() => parseDocument(broken)).toThrowError(/somethingElse/);
  });

  it('can ignore unknown elements on request', () => {
    const broken = invoice.xml.replace(
      '<invoiceNumber>',
      '<somethingElse>x</somethingElse><invoiceNumber>',
    );
    expect(() => parseDocument(broken, { unknownElements: 'ignore' })).not.toThrow();
  });

  it('preserves element order required by the schema', () => {
    const parsed = parseDocument(invoice.xml) as { root: string; value: Record<string, unknown> };
    const xml = serializeDocument(parsed.root, parsed.value);
    expect(xml.indexOf('<invoiceNumber>')).toBeLessThan(xml.indexOf('<invoiceIssueDate>'));
    // Reordering the input object must not reorder the output.
    const reordered = Object.fromEntries(Object.entries(parsed.value).reverse());
    const xmlReordered = serializeDocument(parsed.root, reordered);
    expect(xmlReordered).toBe(xml);
  });
});
