import { createXmlCodec } from '@open-nav/core';
import { ROOTS, TYPES } from './generated/schema.js';
import { NAMESPACE_URIS, XS_PRIMITIVES } from './xml/descriptor.js';

/**
 * The XML codec bound to the eVAT (EAR 2.0) generated schema.
 *
 * Same engine as `@open-nav/core`, different tables — see `createXmlCodec`.
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
