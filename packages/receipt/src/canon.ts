import { DOMParser } from '@xmldom/xmldom';
import { C14nCanonicalization } from 'xml-crypto';

/**
 * Canonical XML 1.0 (RFC 3076) — the normalisation eNyugta requires before an
 * envelope is compressed, encrypted and signed (§4.4). The digital signature is
 * over the canonical bytes, so this must match NAV's canonicalisation exactly;
 * it is delegated to xml-crypto's Canonical-XML-1.0 implementation (the same one
 * the SAML ecosystem relies on) rather than hand-rolled.
 *
 * Canonicalisation without comments: attributes are sorted, empty elements are
 * expanded to start/end tag pairs, character content is normalised, and
 * comments are dropped.
 */

const parser = new DOMParser();
const canonicalizer = new C14nCanonicalization();

/**
 * Canonicalise an XML document (e.g. a `CoreDocument` / `CoreReport`) to its
 * RFC 3076 canonical form, returning the exact bytes to compress and sign.
 */
export function canonicalize(xml: string): string {
  const document = parser.parseFromString(xml, 'text/xml');
  const root = document.documentElement as unknown as Parameters<typeof canonicalizer.process>[0];
  return canonicalizer.process(root, {}) as string;
}
