import { XMLParser } from 'fast-xml-parser';
import { NavValidationError, type ValidationIssue } from '../errors.js';
import type { PrimitiveKind } from './descriptor.js';

/**
 * A schema-table-driven XML codec.
 *
 * The serialise and parse paths are both driven entirely by the generated
 * `TYPES`/`ROOTS` tables and a namespace map, so the same logic serves every
 * NAV system (Online Számla, eVAT, eNyugta) — each binds its own tables with
 * {@link createXmlCodec}. The namespace-key type is left as `string` here so a
 * package's own `NsKey` union (from its `descriptor.ts`) is assignable in.
 */

/** Structural forms of the generated descriptors the codec reads. */
export interface CodecFieldDescriptor {
  name: string;
  ns: string;
  type: string;
  optional?: boolean;
  repeated?: boolean;
  maxOccurs?: number;
}

export interface CodecAttributeDescriptor {
  name: string;
  type: string;
  required: boolean;
}

export interface CodecComplexDescriptor {
  kind: 'complex';
  name: string;
  ns: string;
  tsName: string;
  content: 'element' | 'simple';
  contentType?: string;
  fields: CodecFieldDescriptor[];
  attributes?: CodecAttributeDescriptor[];
}

export interface CodecSimpleDescriptor {
  kind: 'simple';
  name: string;
  ns: string;
  tsName: string;
  primitive: PrimitiveKind;
}

export type CodecDescriptor = CodecComplexDescriptor | CodecSimpleDescriptor;

export interface CodecRootDescriptor {
  name: string;
  ns: string;
  type: string;
}

export interface XmlSchemaTables {
  types: Record<string, CodecDescriptor>;
  roots: Record<string, CodecRootDescriptor>;
  namespaceUris: Record<string, string>;
  xsPrimitives: Record<string, PrimitiveKind>;
}

export interface SerializeOptions {
  /**
   * Indentation for pretty printing, or `false` for a single line.
   *
   * Defaults to `false`: these documents go over the wire, and for
   * `manageInvoice` the invoice payload is hashed and base64 encoded, so there
   * is nothing to be gained from whitespace. Pass `'\t'` or two spaces when a
   * human has to read the result.
   */
  indent?: string | false;
  /** Emit the XML declaration. Defaults to `true`. */
  declaration?: boolean;
}

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

export interface XmlCodec {
  serializeDocument(rootName: string, value: unknown, options?: SerializeOptions): string;
  parseDocument(xml: string, options?: ParseOptions): ParsedDocument;
  parseDocumentAs<T>(xml: string, rootName: string, options?: ParseOptions): T;
}

/** Intermediate tree, built before rendering so used namespaces are known. */
interface Element {
  ns: string;
  name: string;
  attributes: Array<[string, string]>;
  text?: string;
  children: Element[];
}

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

/** Build a codec bound to one system's generated schema tables. */
export function createXmlCodec(tables: XmlSchemaTables): XmlCodec {
  const { types, roots, namespaceUris, xsPrimitives } = tables;
  const uriToNs: Record<string, string> = Object.fromEntries(
    Object.entries(namespaceUris).map(([key, uri]) => [uri, key]),
  );

  // ---- serialise --------------------------------------------------------

  function descriptorFor(typeKey: string, path: string): CodecDescriptor {
    const descriptor = types[typeKey];
    if (!descriptor) {
      throw new NavValidationError(`Unknown type ${typeKey}`, [
        { path, code: 'UNKNOWN_TYPE', message: `not present in the generated schema` },
      ]);
    }
    return descriptor;
  }

  function serializeDocument(
    rootName: string,
    value: unknown,
    options: SerializeOptions = {},
  ): string {
    const root = roots[rootName];
    if (!root) {
      throw new NavValidationError(`Unknown document root ${rootName}`, [
        {
          path: '',
          code: 'UNKNOWN_ROOT',
          message: `expected one of ${Object.keys(roots).join(', ')}`,
        },
      ]);
    }

    const issues: ValidationIssue[] = [];
    const element = buildElement(root.name, root.ns, root.type, value, rootName, issues);
    if (issues.length > 0) throw new NavValidationError(`Cannot serialise ${rootName}`, issues);

    const used = new Set<string>();
    collectNamespaces(element, used);
    used.delete(root.ns);

    const declarations: Array<[string, string]> = [
      ...[...used].sort().map((ns): [string, string] => [`xmlns:${ns}`, namespaceUris[ns]!]),
      ['xmlns', namespaceUris[root.ns]!],
    ];

    const indent = options.indent ?? false;
    const body = render(element, root.ns, declarations, indent, 0);
    const declaration =
      options.declaration === false ? '' : '<?xml version="1.0" encoding="UTF-8"?>';
    if (!declaration) return body;
    return indent === false ? `${declaration}${body}` : `${declaration}\n${body}`;
  }

  function buildElement(
    name: string,
    ns: string,
    typeKey: string,
    value: unknown,
    path: string,
    issues: ValidationIssue[],
  ): Element {
    const primitive = xsPrimitives[typeKey];
    if (primitive) {
      return {
        ns,
        name,
        attributes: [],
        text: formatPrimitive(primitive, value, path, issues),
        children: [],
      };
    }

    const descriptor = descriptorFor(typeKey, path);

    if (descriptor.kind === 'simple') {
      return {
        ns,
        name,
        attributes: [],
        text: formatPrimitive(descriptor.primitive, value, path, issues),
        children: [],
      };
    }

    if (descriptor.content === 'simple') {
      return buildSimpleContentElement(name, ns, descriptor, value, path, issues);
    }

    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      issues.push({
        path,
        code: 'EXPECTED_OBJECT',
        message: `expected an object, got ${describe(value)}`,
      });
      return { ns, name, attributes: [], children: [] };
    }

    const record = value as Record<string, unknown>;
    const children: Element[] = [];

    for (const field of descriptor.fields) {
      const fieldValue = record[field.name];
      const fieldPath = path ? `${path}.${field.name}` : field.name;

      if (fieldValue === undefined || fieldValue === null) {
        if (!field.optional)
          issues.push({ path: fieldPath, code: 'REQUIRED', message: 'is required' });
        continue;
      }

      if (field.repeated) {
        if (!Array.isArray(fieldValue)) {
          issues.push({
            path: fieldPath,
            code: 'EXPECTED_ARRAY',
            message: `is repeatable and expects an array, got ${describe(fieldValue)}`,
          });
          continue;
        }
        if (field.maxOccurs !== undefined && fieldValue.length > field.maxOccurs) {
          issues.push({
            path: fieldPath,
            code: 'MAX_OCCURS',
            message: `allows at most ${field.maxOccurs} entries, got ${fieldValue.length}`,
          });
        }
        for (const [index, item] of fieldValue.entries()) {
          children.push(
            buildElement(field.name, field.ns, field.type, item, `${fieldPath}.${index}`, issues),
          );
        }
        continue;
      }

      if (Array.isArray(fieldValue)) {
        issues.push({
          path: fieldPath,
          code: 'UNEXPECTED_ARRAY',
          message: 'occurs at most once and does not accept an array',
        });
        continue;
      }

      children.push(buildElement(field.name, field.ns, field.type, fieldValue, fieldPath, issues));
    }

    const unknown = Object.keys(record).filter(
      (key) => !descriptor.fields.some((field) => field.name === key),
    );
    for (const key of unknown) {
      issues.push({
        path: path ? `${path}.${key}` : key,
        code: 'UNKNOWN_FIELD',
        message: `is not part of ${descriptor.name}`,
      });
    }

    return { ns, name, attributes: [], children };
  }

  function buildSimpleContentElement(
    name: string,
    ns: string,
    descriptor: CodecComplexDescriptor,
    value: unknown,
    path: string,
    issues: ValidationIssue[],
  ): Element {
    if (typeof value !== 'object' || value === null) {
      issues.push({
        path,
        code: 'EXPECTED_OBJECT',
        message: `expected an object with a value and attributes, got ${describe(value)}`,
      });
      return { ns, name, attributes: [], children: [] };
    }

    const record = value as Record<string, unknown>;
    const contentKind = primitiveOf(descriptor.contentType, path);
    const attributes: Array<[string, string]> = [];

    for (const attribute of descriptor.attributes ?? []) {
      const attributeValue = record[attribute.name];
      if (attributeValue === undefined || attributeValue === null) {
        if (attribute.required) {
          issues.push({
            path: `${path}@${attribute.name}`,
            code: 'REQUIRED',
            message: 'attribute is required',
          });
        }
        continue;
      }
      attributes.push([
        attribute.name,
        formatPrimitive(
          primitiveOf(attribute.type, path),
          attributeValue,
          `${path}@${attribute.name}`,
          issues,
        ),
      ]);
    }

    return {
      ns,
      name,
      attributes,
      text: formatPrimitive(contentKind, record['value'], `${path}.value`, issues),
      children: [],
    };
  }

  function primitiveOf(typeKey: string | undefined, path: string): PrimitiveKind {
    if (!typeKey) {
      throw new NavValidationError('Missing type', [
        { path, code: 'UNKNOWN_TYPE', message: 'simple content without a declared type' },
      ]);
    }
    const primitive = xsPrimitives[typeKey];
    if (primitive) return primitive;
    const descriptor = descriptorFor(typeKey, path);
    if (descriptor.kind !== 'simple') {
      throw new NavValidationError('Unexpected complex type', [
        { path, code: 'UNKNOWN_TYPE', message: `${typeKey} is not a simple type` },
      ]);
    }
    return descriptor.primitive;
  }

  // ---- parse ------------------------------------------------------------

  function parseDocument(xml: string, options: ParseOptions = {}): ParsedDocument {
    const document = parser.parse(xml) as OrderedNode[];
    const rootNode = document.find((node) => {
      const tag = tagOf(node);
      return tag !== '#text' && tag !== '#comment' && !tag.startsWith('?');
    });
    if (!rootNode) throw new NavValidationError('No root element found in document');

    const { local } = splitName(tagOf(rootNode));
    const root = roots[local];
    if (!root) {
      throw new NavValidationError(`Unknown document root ${local}`, [
        {
          path: '',
          code: 'UNKNOWN_ROOT',
          message: `expected one of ${Object.keys(roots).join(', ')}`,
        },
      ]);
    }

    const issues: ValidationIssue[] = [];
    const scope = new Scope().extend(attrsOf(rootNode));
    const value = readComplex(rootNode, root.type, scope, local, issues, options);
    if (issues.length > 0) throw new NavValidationError(`Cannot parse ${local}`, issues);
    return { root: local, value };
  }

  function parseDocumentAs<T>(xml: string, rootName: string, options?: ParseOptions): T {
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
    const descriptor = types[typeKey];
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
      const ns = uri === undefined ? undefined : uriToNs[uri];

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
      const primitive = xsPrimitives[field.type];
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
    descriptor: CodecComplexDescriptor,
    path: string,
    issues: ValidationIssue[],
  ): unknown {
    const contentDescriptor = descriptor.contentType ? types[descriptor.contentType] : undefined;
    const kind: PrimitiveKind =
      xsPrimitives[descriptor.contentType ?? ''] ??
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
      const attributeDescriptor = types[attribute.type];
      const attributeKind: PrimitiveKind =
        xsPrimitives[attribute.type] ??
        (attributeDescriptor?.kind === 'simple' ? attributeDescriptor.primitive : 'string');
      result[attribute.name] = readPrimitive(
        attributeKind,
        raw,
        `${path}@${attribute.name}`,
        issues,
      );
    }

    return result;
  }

  return { serializeDocument, parseDocument, parseDocumentAs };
}

// ---- pure helpers (no table dependency) ---------------------------------

function collectNamespaces(element: Element, used: Set<string>): void {
  used.add(element.ns);
  for (const child of element.children) collectNamespaces(child, used);
}

function formatPrimitive(
  kind: PrimitiveKind,
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): string {
  switch (kind) {
    case 'boolean':
      if (typeof value === 'boolean') return value ? 'true' : 'false';
      if (value === 'true' || value === 'false') return value;
      issues.push({
        path,
        code: 'EXPECTED_BOOLEAN',
        message: `expected a boolean, got ${describe(value)}`,
      });
      return '';

    case 'integer':
      if (typeof value === 'number') {
        if (!Number.isInteger(value)) {
          issues.push({
            path,
            code: 'EXPECTED_INTEGER',
            message: `expected an integer, got ${value}`,
          });
          return '';
        }
        return String(value);
      }
      if (typeof value === 'string' && /^-?\d+$/.test(value)) return value;
      issues.push({
        path,
        code: 'EXPECTED_INTEGER',
        message: `expected an integer, got ${describe(value)}`,
      });
      return '';

    case 'decimal':
      // Strings are the intended representation: they survive 18 significant
      // digits and rates like 0.27 without a floating point detour.
      if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value)) return value;
      if (typeof value === 'number' && Number.isFinite(value)) return String(value);
      issues.push({
        path,
        code: 'EXPECTED_DECIMAL',
        message: `expected a decimal, got ${describe(value)}`,
      });
      return '';

    default:
      if (typeof value === 'string') return value;
      if (typeof value === 'number' || typeof value === 'boolean') return String(value);
      issues.push({
        path,
        code: 'EXPECTED_STRING',
        message: `expected a string, got ${describe(value)}`,
      });
      return '';
  }
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeof value;
}

function render(
  element: Element,
  defaultNs: string,
  extraAttributes: Array<[string, string]>,
  indent: string | false,
  depth: number,
): string {
  const tag = element.ns === defaultNs ? element.name : `${element.ns}:${element.name}`;
  const attributes = [...element.attributes, ...extraAttributes]
    .map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`)
    .join('');

  const pad = indent === false ? '' : indent.repeat(depth);
  const newline = indent === false ? '' : '\n';

  if (element.children.length === 0) {
    const text = element.text ?? '';
    if (text === '') return `${pad}<${tag}${attributes}/>`;
    return `${pad}<${tag}${attributes}>${escapeText(text)}</${tag}>`;
  }

  const children = element.children
    .map((child) => render(child, defaultNs, [], indent, depth + 1))
    .join(newline);
  return `${pad}<${tag}${attributes}>${newline}${children}${newline}${pad}</${tag}>`;
}

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttribute(value: string): string {
  return escapeText(value)
    .replace(/"/g, '&quot;')
    .replace(/[\n\r\t]/g, (char) => (char === '\n' ? '&#10;' : char === '\r' ? '&#13;' : '&#9;'));
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
