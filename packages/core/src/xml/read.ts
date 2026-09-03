import { XMLParser } from 'fast-xml-parser';
import { NavValidationError, type ValidationIssue } from '../errors.js';
import { ROOTS, TYPES } from '../generated/schema.js';
import {
  NAMESPACE_URIS,
  XS_PRIMITIVES,
  type ComplexDescriptor,
  type NsKey,
  type PrimitiveKind,
} from './descriptor.js';

const URI_TO_NS: Record<string, NsKey> = Object.fromEntries(
  Object.entries(NAMESPACE_URIS).map(([key, uri]) => [uri, key as NsKey]),
) as Record<string, NsKey>;

/** A node as produced by fast-xml-parser in `preserveOrder` mode. */
type OrderedNode = Record<string, unknown>;

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  trimValues: true,
  // Values are converted according to the schema, not guessed from their
  // shape: an invoice number of "2021000123" must stay a string.
  parseTagValue: false,
  parseAttributeValue: false,
});

export interface ParseOptions {
  /**
   * What to do with elements the schema does not declare.
   *
   * `error` (the default) surfaces them, which is what you want for documents
   * you produced yourself. Use `ignore` when reading responses from a NAV
   * deployment that may be ahead of the vendored schema.
   */
  unknownElements?: 'error' | 'ignore';
}

export interface ParsedDocument {
  /** Root element name, e.g. `ManageInvoiceResponse`. */
  root: string;
  value: unknown;
}

/** Namespace prefixes in scope, inherited down the tree. */
class Scope {
  constructor(
    private readonly byPrefix: Map<string, string> = new Map(),
    readonly defaultUri: string | undefined = undefined,
  ) {}

  extend(attributes: Record<string, string>): Scope {
    let next: Map<string, string> | undefined;
    let defaultUri = this.defaultUri;
    for (const [name, value] of Object.entries(attributes)) {
      if (name === '@xmlns') {
        defaultUri = value;
      } else if (name.startsWith('@xmlns:')) {
        next ??= new Map(this.byPrefix);
        next.set(name.slice('@xmlns:'.length), value);
      }
    }
    if (!next && defaultUri === this.defaultUri) return this;
    return new Scope(next ?? this.byPrefix, defaultUri);
  }

  resolve(prefix: string): string | undefined {
    return prefix === '' ? this.defaultUri : this.byPrefix.get(prefix);
  }
}

function tagOf(node: OrderedNode): string {
  const tag = Object.keys(node).find((key) => key !== ':@');
  if (tag === undefined) throw new NavValidationError('Malformed XML node');
  return tag;
}

function childrenOf(node: OrderedNode): OrderedNode[] {
  const value = node[tagOf(node)];
  return Array.isArray(value) ? (value as OrderedNode[]) : [];
}

function attrsOf(node: OrderedNode): Record<string, string> {
  return (node[':@'] as Record<string, string> | undefined) ?? {};
}

function textOf(node: OrderedNode): string {
  return childrenOf(node)
    .filter((child) => tagOf(child) === '#text')
    .map((child) => String(child['#text']))
    .join('');
}

function elementChildren(node: OrderedNode): OrderedNode[] {
  return childrenOf(node).filter((child) => {
    const tag = tagOf(child);
    return tag !== '#text' && tag !== '#comment' && !tag.startsWith('?');
  });
}

function splitName(qname: string): { prefix: string; local: string } {
  const index = qname.indexOf(':');
  return index === -1
    ? { prefix: '', local: qname }
    : { prefix: qname.slice(0, index), local: qname.slice(index + 1) };
}

/**
 * Parse a NAV document into the shape of its generated type.
 *
 * The root element name decides which descriptor is used, so responses and
 * invoice payloads both go through the same path.
 */
export function parseDocument(xml: string, options: ParseOptions = {}): ParsedDocument {
  const document = parser.parse(xml) as OrderedNode[];
  const rootNode = document.find((node) => {
    const tag = tagOf(node);
    return tag !== '#text' && tag !== '#comment' && !tag.startsWith('?');
  });
  if (!rootNode) {
    throw new NavValidationError('No root element found in document');
  }

  const { local } = splitName(tagOf(rootNode));
  const root = ROOTS[local];
  if (!root) {
    throw new NavValidationError(`Unknown document root ${local}`, [
      {
        path: '',
        code: 'UNKNOWN_ROOT',
        message: `expected one of ${Object.keys(ROOTS).join(', ')}`,
      },
    ]);
  }

  const issues: ValidationIssue[] = [];
  const scope = new Scope().extend(attrsOf(rootNode));
  const value = readComplex(rootNode, root.type, scope, local, issues, options);
  if (issues.length > 0) {
    throw new NavValidationError(`Cannot parse ${local}`, issues);
  }

  return { root: local, value };
}

/** Parse a document whose root is known, returning the generated type. */
export function parseDocumentAs<T>(xml: string, rootName: string, options?: ParseOptions): T {
  const parsed = parseDocument(xml, options);
  if (parsed.root !== rootName) {
    throw new NavValidationError(`Expected a ${rootName} document but found ${parsed.root}`);
  }
  return parsed.value as T;
}

function readComplex(
  node: OrderedNode,
  typeKey: string,
  scope: Scope,
  path: string,
  issues: ValidationIssue[],
  options: ParseOptions,
): unknown {
  const descriptor = TYPES[typeKey];
  if (!descriptor) {
    issues.push({
      path,
      code: 'UNKNOWN_TYPE',
      message: `${typeKey} is not in the generated schema`,
    });
    return undefined;
  }

  if (descriptor.kind === 'simple') {
    return readPrimitive(descriptor.primitive, textOf(node), path, issues);
  }

  if (descriptor.content === 'simple') {
    return readSimpleContent(node, descriptor, path, issues);
  }

  const result: Record<string, unknown> = {};
  const localScope = scope.extend(attrsOf(node));

  for (const child of elementChildren(node)) {
    const { prefix, local } = splitName(tagOf(child));
    const childScope = localScope.extend(attrsOf(child));
    const uri = childScope.resolve(prefix);
    const ns = uri === undefined ? undefined : URI_TO_NS[uri];

    const field = descriptor.fields.find(
      (candidate) => candidate.name === local && (ns === undefined || candidate.ns === ns),
    );
    if (!field) {
      if (options.unknownElements !== 'ignore') {
        issues.push({
          path: path ? `${path}.${local}` : local,
          code: 'UNKNOWN_ELEMENT',
          message: `is not declared on ${descriptor.name}`,
        });
      }
      continue;
    }

    const fieldPath = path ? `${path}.${field.name}` : field.name;
    const primitive = XS_PRIMITIVES[field.type];
    const value = primitive
      ? readPrimitive(primitive, textOf(child), fieldPath, issues)
      : readComplex(child, field.type, childScope, fieldPath, issues, options);

    if (field.repeated) {
      result[field.name] ??= [] as unknown[];
      (result[field.name] as unknown[]).push(value);
    } else {
      result[field.name] = value;
    }
  }

  return result;
}

function readSimpleContent(
  node: OrderedNode,
  descriptor: ComplexDescriptor,
  path: string,
  issues: ValidationIssue[],
): unknown {
  const contentDescriptor = descriptor.contentType ? TYPES[descriptor.contentType] : undefined;
  const kind: PrimitiveKind =
    XS_PRIMITIVES[descriptor.contentType ?? ''] ??
    (contentDescriptor?.kind === 'simple' ? contentDescriptor.primitive : 'string');

  const result: Record<string, unknown> = {
    value: readPrimitive(kind, textOf(node), `${path}.value`, issues),
  };

  const attributes = attrsOf(node);
  for (const attribute of descriptor.attributes ?? []) {
    const raw = attributes[`@${attribute.name}`];
    if (raw === undefined) {
      if (attribute.required) {
        issues.push({
          path: `${path}@${attribute.name}`,
          code: 'REQUIRED',
          message: 'attribute is required',
        });
      }
      continue;
    }
    const attributeDescriptor = TYPES[attribute.type];
    const attributeKind: PrimitiveKind =
      XS_PRIMITIVES[attribute.type] ??
      (attributeDescriptor?.kind === 'simple' ? attributeDescriptor.primitive : 'string');
    result[attribute.name] = readPrimitive(attributeKind, raw, `${path}@${attribute.name}`, issues);
  }

  return result;
}

function readPrimitive(
  kind: PrimitiveKind,
  raw: string,
  path: string,
  issues: ValidationIssue[],
): unknown {
  switch (kind) {
    case 'boolean':
      if (raw === 'true' || raw === '1') return true;
      if (raw === 'false' || raw === '0') return false;
      issues.push({ path, code: 'EXPECTED_BOOLEAN', message: `expected a boolean, got "${raw}"` });
      return undefined;

    case 'integer': {
      if (!/^-?\d+$/.test(raw)) {
        issues.push({
          path,
          code: 'EXPECTED_INTEGER',
          message: `expected an integer, got "${raw}"`,
        });
        return undefined;
      }
      const parsed = Number(raw);
      if (!Number.isSafeInteger(parsed)) {
        issues.push({
          path,
          code: 'INTEGER_OUT_OF_RANGE',
          message: `${raw} exceeds the safe integer range`,
        });
        return undefined;
      }
      return parsed;
    }

    case 'base64Binary':
      // XML permits whitespace inside base64; NAV's own samples wrap it.
      return raw.replace(/\s+/g, '');

    default:
      // Decimals stay strings deliberately, see the generator's TS_PRIMITIVES.
      return raw;
  }
}
