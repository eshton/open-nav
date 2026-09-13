import { ROOTS, TYPES } from '../generated/schema.js';
import { NAMESPACE_URIS, XS_PRIMITIVES } from './descriptor.js';
import { createXmlCodec, type ParseOptions, type ParsedDocument } from './codec.js';

export type { ParseOptions, ParsedDocument } from './codec.js';

const codec = createXmlCodec({
  types: TYPES,
  roots: ROOTS,
  namespaceUris: NAMESPACE_URIS,
  xsPrimitives: XS_PRIMITIVES,
});

/**
 * Parse a NAV document into the shape of its generated type.
 *
 * The root element name decides which descriptor is used, so responses and
 * invoice payloads both go through the same path.
 */
export function parseDocument(xml: string, options?: ParseOptions): ParsedDocument {
  return codec.parseDocument(xml, options);
}

/** Parse a document whose root is known, returning the generated type. */
export function parseDocumentAs<T>(xml: string, rootName: string, options?: ParseOptions): T {
  return codec.parseDocumentAs<T>(xml, rootName, options);
}
