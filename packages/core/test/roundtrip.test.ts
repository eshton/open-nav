import { XMLParser } from 'fast-xml-parser';
import { describe, expect, it } from 'vitest';
import { NAMESPACE_URIS } from '../src/xml/descriptor.js';
import { parseDocument } from '../src/xml/read.js';
import { serializeDocument } from '../src/xml/write.js';
import { loadFixtures } from './fixtures.js';

/**
 * Every document NAV publishes must survive a parse → serialise round trip
 * without losing or reordering anything.
 *
 * This is the substitute for testing against NAV's live system: the fixtures
 * are the authority's own examples, so a document that fails here is a
 * document this library would have got rejected.
 */

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  trimValues: false,
  parseTagValue: false,
  parseAttributeValue: false,
});

type OrderedNode = Record<string, unknown>;

interface CanonicalNode {
  /** `namespaceUri|localName`, so prefix choices cannot affect the comparison. */
  name: string;
  attributes: Record<string, string>;
  text?: string;
  children: CanonicalNode[];
}

const tagOf = (node: OrderedNode): string => Object.keys(node).find((key) => key !== ':@')!;
const childrenOf = (node: OrderedNode): OrderedNode[] => {
  const value = node[tagOf(node)];
  return Array.isArray(value) ? (value as OrderedNode[]) : [];
};
const attrsOf = (node: OrderedNode): Record<string, string> =>
  (node[':@'] as Record<string, string> | undefined) ?? {};

/**
 * Normalise text for comparison.
 *
 * NAV's samples wrap long base64 payloads across lines while this library
 * emits them unwrapped, so base64-shaped values have their whitespace
 * removed. Everything else only has runs of whitespace collapsed, which still
 * catches a serialiser that drops or invents a character.
 */
function normaliseText(raw: string): string {
  const trimmed = raw.trim();
  if (/^[A-Za-z0-9+/=\s]{64,}$/.test(trimmed)) return trimmed.replace(/\s+/g, '');
  return trimmed.replace(/\s+/g, ' ');
}

function canonicalise(xml: string): CanonicalNode {
  const document = parser.parse(xml) as OrderedNode[];
  const root = document.find((node) => {
    const tag = tagOf(node);
    return tag !== '#text' && tag !== '#comment' && !tag.startsWith('?');
  });
  if (!root) throw new Error('no root element');
  return visit(root, new Map(), undefined);
}

function visit(
  node: OrderedNode,
  prefixes: Map<string, string>,
  defaultUri: string | undefined,
): CanonicalNode {
  const attributes = attrsOf(node);
  let scope = prefixes;
  let scopeDefault = defaultUri;
  for (const [name, value] of Object.entries(attributes)) {
    if (name === '@xmlns') scopeDefault = value;
    else if (name.startsWith('@xmlns:')) {
      scope = new Map(scope);
      scope.set(name.slice('@xmlns:'.length), value);
    }
  }

  const qname = tagOf(node);
  const colon = qname.indexOf(':');
  const prefix = colon === -1 ? '' : qname.slice(0, colon);
  const local = colon === -1 ? qname : qname.slice(colon + 1);
  const uri = (prefix === '' ? scopeDefault : scope.get(prefix)) ?? '';

  const meaningful = childrenOf(node).filter((child) => {
    const tag = tagOf(child);
    return tag !== '#text' && tag !== '#comment' && !tag.startsWith('?');
  });
  const text = childrenOf(node)
    .filter((child) => tagOf(child) === '#text')
    .map((child) => String(child['#text']))
    .join('');

  const keptAttributes: Record<string, string> = {};
  for (const [name, value] of Object.entries(attributes)) {
    if (name === '@xmlns' || name.startsWith('@xmlns:') || name.startsWith('@xsi:')) continue;
    keptAttributes[name.slice(1)] = value;
  }

  const canonical: CanonicalNode = {
    name: `${uri}|${local}`,
    attributes: keptAttributes,
    children: meaningful.map((child) => visit(child, scope, scopeDefault)),
  };
  // Text is only meaningful on leaves; between elements it is layout.
  if (meaningful.length === 0) canonical.text = normaliseText(text);
  return canonical;
}

const KNOWN_URIS = new Set(Object.values(NAMESPACE_URIS));

describe.each([['api-samples', 11] as const, ['data-samples', 30] as const])(
  '%s round trip',
  (kind, expectedCount) => {
    const fixtures = loadFixtures(kind);

    it(`loads all ${expectedCount} fixtures`, () => {
      expect(fixtures).toHaveLength(expectedCount);
    });

    for (const fixture of fixtures) {
      it(`round trips ${fixture.name}`, () => {
        const parsed = parseDocument(fixture.xml);
        const reserialised = serializeDocument(parsed.root, parsed.value);
        const reparsed = parseDocument(reserialised);

        // The value model is stable: serialising and reading back changes nothing.
        expect(reparsed.value).toEqual(parsed.value);

        // And the XML itself still says what NAV's document said.
        expect(canonicalise(reserialised)).toEqual(canonicalise(fixture.xml));
      });
    }

    it('every element resolves to a NAV namespace', () => {
      for (const fixture of fixtures) {
        const walk = (node: CanonicalNode): void => {
          const uri = node.name.slice(0, node.name.indexOf('|'));
          expect(KNOWN_URIS.has(uri), `${fixture.name}: ${node.name}`).toBe(true);
          node.children.forEach(walk);
        };
        walk(canonicalise(fixture.xml));
      }
    });
  },
);
