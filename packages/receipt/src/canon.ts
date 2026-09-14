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

const canonicalizer = new C14nCanonicalization();

/**
 * Canonicalise an XML document (e.g. a `CoreDocument` / `CoreReport`) to its
 * RFC 3076 canonical form, returning the exact bytes to compress and sign.
 *
 * The envelope signature is computed over these bytes, so malformed input must
 * fail loudly here rather than silently produce bytes NAV rejects at signature
 * verification: `@xmldom/xmldom` does not throw on parse errors by default, so
 * an `errorHandler` is installed and a missing root element is rejected.
 */
export function canonicalize(xml: string): string {
  const parser = new DOMParser({
    errorHandler: (level: string, message: string) => {
      if (level !== 'warning') throw new Error(`cannot canonicalize malformed XML: ${message}`);
    },
  });
  const document = parser.parseFromString(xml, 'text/xml');
  if (!document.documentElement) {
    throw new Error('cannot canonicalize XML: no root element');
  }
  const root = document.documentElement as unknown as Parameters<typeof canonicalizer.process>[0];
  return canonicalizer.process(root, {}) as string;
}
