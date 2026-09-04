import { NavValidationError, type ValidationIssue } from '../errors.js';
import { ROOTS, TYPES } from '../generated/schema.js';
import {
  NAMESPACE_URIS,
  XS_PRIMITIVES,
  type ComplexDescriptor,
  type Descriptor,
  type NsKey,
  type PrimitiveKind,
} from './descriptor.js';

/** Prefixes used when a namespace is not the document's default. */
export const NS_PREFIXES: Record<NsKey, string> = {
  common: 'common',
  base: 'base',
  data: 'data',
  api: 'api',
  annul: 'annul',
  metrics: 'metrics',
};

export interface SerializeOptions {
  /**
   * Indentation for pretty printing, or `false` for a single line.
   *
   * Defaults to `false`: these documents go over the wire, and for
   * `manageInvoice` the invoice payload is hashed and base64 encoded, so
   * there is nothing to be gained from whitespace. Pass `'\t'` or two spaces
   * when a human has to read the result.
   */
  indent?: string | false;
  /** Emit the XML declaration. Defaults to `true`. */
  declaration?: boolean;
}

/** Intermediate tree, built before rendering so used namespaces are known. */
interface Element {
  ns: NsKey;
  name: string;
  attributes: Array<[string, string]>;
  text?: string;
  children: Element[];
}

/**
 * Serialise a document from its root element name.
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
  options: SerializeOptions = {},
): string {
  const root = ROOTS[rootName];
  if (!root) {
    throw new NavValidationError(`Unknown document root ${rootName}`, [
      {
        path: '',
        code: 'UNKNOWN_ROOT',
        message: `expected one of ${Object.keys(ROOTS).join(', ')}`,
      },
    ]);
  }

  const issues: ValidationIssue[] = [];
  const element = buildElement(root.name, root.ns, root.type, value, rootName, issues);
  if (issues.length > 0) {
    throw new NavValidationError(`Cannot serialise ${rootName}`, issues);
  }

  const used = new Set<NsKey>();
  collectNamespaces(element, used);
  used.delete(root.ns);

  const declarations: Array<[string, string]> = [
    ...[...used]
      .sort()
      .map((ns): [string, string] => [`xmlns:${NS_PREFIXES[ns]}`, NAMESPACE_URIS[ns]]),
    ['xmlns', NAMESPACE_URIS[root.ns]],
  ];

  const indent = options.indent ?? false;
  const body = render(element, root.ns, declarations, indent, 0);
  const declaration = options.declaration === false ? '' : '<?xml version="1.0" encoding="UTF-8"?>';
  if (!declaration) return body;
  return indent === false ? `${declaration}${body}` : `${declaration}\n${body}`;
}

function collectNamespaces(element: Element, used: Set<NsKey>): void {
  used.add(element.ns);
  for (const child of element.children) collectNamespaces(child, used);
}

function descriptorFor(typeKey: string, path: string): Descriptor {
  const descriptor = TYPES[typeKey];
  if (!descriptor) {
    throw new NavValidationError(`Unknown type ${typeKey}`, [
      { path, code: 'UNKNOWN_TYPE', message: `not present in the generated schema` },
    ]);
  }
  return descriptor;
}

function buildElement(
  name: string,
  ns: NsKey,
  typeKey: string,
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): Element {
  const primitive = XS_PRIMITIVES[typeKey];
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
      if (!field.optional) {
        issues.push({ path: fieldPath, code: 'REQUIRED', message: 'is required' });
      }
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
  ns: NsKey,
  descriptor: ComplexDescriptor,
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
  const primitive = XS_PRIMITIVES[typeKey];
  if (primitive) return primitive;
  const descriptor = descriptorFor(typeKey, path);
  if (descriptor.kind !== 'simple') {
    throw new NavValidationError('Unexpected complex type', [
      { path, code: 'UNKNOWN_TYPE', message: `${typeKey} is not a simple type` },
    ]);
  }
  return descriptor.primitive;
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
  defaultNs: NsKey,
  extraAttributes: Array<[string, string]>,
  indent: string | false,
  depth: number,
): string {
  const tag =
    element.ns === defaultNs ? element.name : `${NS_PREFIXES[element.ns]}:${element.name}`;
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
