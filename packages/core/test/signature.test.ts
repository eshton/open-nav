import { describe, expect, it } from 'vitest';
import { operationHash, requestSignature } from '../src/crypto/signature.js';
import { toSignatureTimestamp } from '../src/time.js';
import { loadFixtures } from './fixtures.js';

/**
 * NAV's published request samples double as signature test vectors: each one
 * carries the `signKey` and the per-operation hashes in XML comments next to
 * the `requestSignature` they produce. That makes them the only way to verify
 * the signature algorithm without a technical user's credentials — and the
 * batch case pins down the one detail the prose specification leaves easiest
 * to get wrong, namely that per-operation hashes are concatenated in index
 * order after the sign key.
 */

const element = (xml: string, tag: string): string | undefined =>
  xml.match(new RegExp(`<(?:common:)?${tag}[^>]*>([^<]*)</(?:common:)?${tag}>`))?.[1];

const commented = (xml: string, tag: string): string | undefined =>
  xml.match(new RegExp(`<!--<${tag}>([^<]*)</${tag}>-->`))?.[1];

const INDEX_HASH_TAGS = ['firstIndexHash', 'secondIndexHash', 'thirdIndexHash'];

/** Operations in the batch, whether invoice or annulment. */
function readOperations(xml: string): Array<{ index: number; operation: string; payload: string }> {
  const pattern =
    /<(invoiceOperation|annulmentOperation)>\s*<index>(\d+)<\/index>\s*<(?:invoiceOperation|annulmentOperation)>(\w+)<\/(?:invoiceOperation|annulmentOperation)>\s*<(?:invoiceData|invoiceAnnulment)>([\s\S]*?)<\/(?:invoiceData|invoiceAnnulment)>/g;
  return [...xml.matchAll(pattern)].map((match) => ({
    index: Number(match[2]),
    operation: match[3]!,
    // Base64 in the samples is pretty-printed across lines; the signature is
    // computed over the value as it appears on the wire, without whitespace.
    payload: match[4]!.replace(/\s+/g, ''),
  }));
}

const fixtures = loadFixtures('api-samples');

describe('requestSignature against NAV request samples', () => {
  it('covers every published API sample', () => {
    expect(fixtures.length).toBe(11);
    expect(fixtures.every((fixture) => commented(fixture.xml, 'signKey'))).toBe(true);
  });

  for (const fixture of fixtures) {
    it(`reproduces the signature of ${fixture.name}`, () => {
      const requestId = element(fixture.xml, 'requestId');
      const timestamp = element(fixture.xml, 'timestamp');
      const signKey = commented(fixture.xml, 'signKey');
      const expected = element(fixture.xml, 'requestSignature');
      expect(requestId, 'requestId').toBeTruthy();
      expect(timestamp, 'timestamp').toBeTruthy();
      expect(signKey, 'signKey').toBeTruthy();
      expect(expected, 'requestSignature').toBeTruthy();

      const operations = readOperations(fixture.xml).map((operation) => ({
        index: operation.index,
        operation: operation.operation,
        base64Payload: operation.payload,
      }));

      const actual = requestSignature(requestId!, timestamp!, signKey!, operations);
      expect(actual).toBe(expected);
    });
  }
});

describe('operationHash against NAV request samples', () => {
  const withOperations = fixtures.filter((fixture) => readOperations(fixture.xml).length > 0);

  it('finds the batch samples', () => {
    expect(withOperations.map((fixture) => fixture.name)).toEqual([
      'manageannulment.xml',
      'manageinvoice.xml',
    ]);
  });

  for (const fixture of withOperations) {
    it(`reproduces the per-operation hashes of ${fixture.name}`, () => {
      const operations = readOperations(fixture.xml);
      expect(operations.length).toBeGreaterThan(0);

      for (const [position, operation] of operations.entries()) {
        const documented = commented(fixture.xml, INDEX_HASH_TAGS[position]!);
        expect(documented, `documented hash for index ${operation.index}`).toBeTruthy();
        expect(operationHash(operation.operation, operation.payload)).toBe(documented);
      }
    });
  }
});

describe('signature timestamp', () => {
  it('truncates the header timestamp to whole seconds in UTC', () => {
    expect(toSignatureTimestamp('2020-09-11T12:44:55.442Z')).toBe('20200911124455');
  });

  it('converts a non-UTC instant before formatting', () => {
    expect(toSignatureTimestamp('2020-09-11T14:44:55.442+02:00')).toBe('20200911124455');
  });
});
