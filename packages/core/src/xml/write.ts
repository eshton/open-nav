import { ROOTS, TYPES } from '../generated/schema.js';
import { NAMESPACE_URIS, XS_PRIMITIVES } from './descriptor.js';
import { createXmlCodec, type SerializeOptions } from './codec.js';

export type { SerializeOptions } from './codec.js';

const codec = createXmlCodec({
  types: TYPES,
  roots: ROOTS,
  namespaceUris: NAMESPACE_URIS,
  xsPrimitives: XS_PRIMITIVES,
});

/**
 * Serialise an Online Számla document from its root element name.
 *
 * Element order, namespaces and cardinality all come from the generated
 * descriptors, so the output follows the XSD's sequence order — which is what
 * NAV validates against.
 *
 * @param rootName root element name, e.g. `InvoiceData` or `ManageInvoiceRequest`
 * @param value    the document, shaped like the generated type of that root
 */
export function serializeDocument(
  rootName: string,
  value: unknown,
  options?: SerializeOptions,
): string {
  return codec.serializeDocument(rootName, value, options);
}
