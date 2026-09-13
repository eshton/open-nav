import { createXmlCodec } from '@open-nav/core';
import { ROOTS, TYPES } from './generated/schema.js';
import { NAMESPACE_URIS, XS_PRIMITIVES } from './xml/descriptor.js';

/**
 * The XML codec bound to the eNyugta (ERECEIPT 1.1) generated schema — same
 * engine as `@open-nav/core`, different tables (see `createXmlCodec`).
 */
const codec = createXmlCodec({
  types: TYPES,
  roots: ROOTS,
  namespaceUris: NAMESPACE_URIS,
  xsPrimitives: XS_PRIMITIVES,
});

export const serializeDocument = codec.serializeDocument;
export const parseDocument = codec.parseDocument;
export const parseDocumentAs = codec.parseDocumentAs;
