import { readFileSync } from 'node:fs';
import { XMLParser } from 'fast-xml-parser';
import {
  CodegenError,
  NAMESPACES,
  type AttributeDef,
  type ChoiceGroup,
  type ComplexTypeDef,
  type Doc,
  type Facets,
  type FieldDef,
  type NsKey,
  type PrimitiveKind,
  type RootElementDef,
  type SchemaModel,
  type SimpleTypeDef,
  type TypeDef,
} from './model.js';

const XSD_NS = 'http://www.w3.org/2001/XMLSchema';

/** A node as produced by fast-xml-parser in `preserveOrder` mode. */
type OrderedNode = Record<string, unknown>;

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
});

function tagOf(node: OrderedNode): string {
  const tag = Object.keys(node).find((key) => key !== ':@');
  if (tag === undefined) {
    throw new CodegenError(`Node without a tag: ${JSON.stringify(node)}`);
  }
  return tag;
}

function childrenOf(node: OrderedNode): OrderedNode[] {
  const value = node[tagOf(node)];
  return Array.isArray(value) ? (value as OrderedNode[]) : [];
}

function attrsOf(node: OrderedNode): Record<string, string> {
  return (node[':@'] as Record<string, string> | undefined) ?? {};
}

function childrenNamed(node: OrderedNode, tag: string): OrderedNode[] {
  return childrenOf(node).filter((child) => tagOf(child) === tag);
}

function firstNamed(node: OrderedNode, tag: string): OrderedNode | undefined {
  return childrenOf(node).find((child) => tagOf(child) === tag);
}

/** Read the `xs:documentation` strings of a node's annotation, by language. */
function docOf(node: OrderedNode): Doc {
  const annotation = firstNamed(node, 'xs:annotation');
  if (!annotation) return {};
  const doc: Doc = {};
  for (const entry of childrenNamed(annotation, 'xs:documentation')) {
    const lang = attrsOf(entry)['@xml:lang'];
    const text = childrenOf(entry)
      .filter((child) => tagOf(child) === '#text')
      .map((child) => String(child['#text']))
      .join(' ')
      .trim();
    if (!text) continue;
    if (lang === 'hu') doc.hu = text;
    else if (lang === 'en') doc.en = text;
  }
  return doc;
}

/** Maps the namespace prefixes declared on an `xs:schema` element. */
class PrefixScope {
  private readonly byPrefix = new Map<string, string>();

  constructor(schemaAttrs: Record<string, string>) {
    for (const [name, value] of Object.entries(schemaAttrs)) {
      if (name === '@xmlns') this.byPrefix.set('', value);
      else if (name.startsWith('@xmlns:')) this.byPrefix.set(name.slice('@xmlns:'.length), value);
    }
  }

  /** Resolve an XSD QName to a type key: `xs:string` or `${nsKey}:${local}`. */
  resolve(qname: string): string {
    const [rawPrefix, rawLocal] = qname.includes(':')
      ? [qname.slice(0, qname.indexOf(':')), qname.slice(qname.indexOf(':') + 1)]
      : ['', qname];
    const uri = this.byPrefix.get(rawPrefix);
    if (uri === undefined) {
      throw new CodegenError(`Undeclared namespace prefix in QName ${qname}`);
    }
    if (uri === XSD_NS) return `xs:${rawLocal}`;
    return `${nsKeyOf(uri)}:${rawLocal}`;
  }
}

function nsKeyOf(uri: string): NsKey {
  for (const [key, value] of Object.entries(NAMESPACES)) {
    if (value === uri) return key as NsKey;
  }
  throw new CodegenError(`Unknown target namespace: ${uri}`);
}

const PRIMITIVES: Record<string, PrimitiveKind> = {
  'xs:string': 'string',
  'xs:normalizedString': 'string',
  'xs:token': 'string',
  'xs:decimal': 'decimal',
  'xs:int': 'integer',
  'xs:integer': 'integer',
  'xs:long': 'integer',
  'xs:short': 'integer',
  'xs:nonNegativeInteger': 'integer',
  'xs:positiveInteger': 'integer',
  'xs:boolean': 'boolean',
  'xs:date': 'date',
  'xs:dateTime': 'dateTime',
  'xs:base64Binary': 'base64Binary',
};

const NUMERIC_FACETS = new Set([
  'xs:length',
  'xs:minLength',
  'xs:maxLength',
  'xs:totalDigits',
  'xs:fractionDigits',
]);
const STRING_FACETS = new Set([
  'xs:minInclusive',
  'xs:maxInclusive',
  'xs:minExclusive',
  'xs:maxExclusive',
]);

interface RawSimpleType {
  def: Omit<SimpleTypeDef, 'facets'> & { facets?: Facets };
  baseKey: string;
  ownFacets: Partial<Facets>;
}

/** Parse every schema file into one model, resolving across namespaces. */
export function parseSchemas(files: string[]): SchemaModel {
  const types = new Map<string, TypeDef>();
  const roots: RootElementDef[] = [];
  const rawSimple = new Map<string, RawSimpleType>();

  for (const file of files) {
    const document = parser.parse(readFileSync(file, 'utf8')) as OrderedNode[];
    const schema = document.find((node) => tagOf(node) === 'xs:schema');
    if (!schema) throw new CodegenError(`No xs:schema element in ${file}`);

    const scope = new PrefixScope(attrsOf(schema));
    const targetNs = attrsOf(schema)['@targetNamespace'];
    if (!targetNs) throw new CodegenError(`No targetNamespace in ${file}`);
    const ns = nsKeyOf(targetNs);

    for (const node of childrenOf(schema)) {
      const tag = tagOf(node);
      const name = attrsOf(node)['@name'];

      switch (tag) {
        case 'xs:annotation':
        case 'xs:import':
        case '#text':
          break;

        case 'xs:simpleType': {
          if (!name) throw new CodegenError(`Top-level xs:simpleType without a name in ${file}`);
          const raw = readSimpleType(node, ns, name, scope);
          rawSimple.set(raw.def.key, raw);
          break;
        }

        case 'xs:complexType': {
          if (!name) throw new CodegenError(`Top-level xs:complexType without a name in ${file}`);
          const complex = readComplexType(node, ns, name, scope);
          types.set(complex.key, complex);
          break;
        }

        case 'xs:element': {
          // Global elements are the document roots. NAV declares each with an
          // inline anonymous complexType, so the generated type takes the
          // element's own name.
          if (!name) throw new CodegenError(`Top-level xs:element without a name in ${file}`);
          const inline = firstNamed(node, 'xs:complexType');
          const declaredType = attrsOf(node)['@type'];
          let typeKey: string;
          if (inline) {
            const complex = readComplexType(inline, ns, name, scope);
            types.set(complex.key, complex);
            typeKey = complex.key;
          } else if (declaredType) {
            typeKey = scope.resolve(declaredType);
          } else {
            throw new CodegenError(`Root element ${name} has neither a type nor inline content`);
          }
          roots.push({ name, ns, typeKey, doc: docOf(node) });
          break;
        }

        default:
          throw new CodegenError(`Unsupported top-level construct ${tag} in ${file}`);
      }
    }
  }

  for (const key of rawSimple.keys()) {
    types.set(key, resolveSimpleType(key, rawSimple));
  }
  flattenExtensions(types);

  return { types, roots };
}

function readSimpleType(
  node: OrderedNode,
  ns: NsKey,
  name: string,
  scope: PrefixScope,
): RawSimpleType {
  const restriction = firstNamed(node, 'xs:restriction');
  if (!restriction) {
    throw new CodegenError(
      `Simple type ${name} is not a restriction (unions and lists are not supported)`,
    );
  }
  const baseAttr = attrsOf(restriction)['@base'];
  if (!baseAttr) throw new CodegenError(`Simple type ${name} has a restriction without a base`);
  const baseKey = scope.resolve(baseAttr);

  const ownFacets: Partial<Facets> = {};
  const enumValues: string[] = [];
  for (const facet of childrenOf(restriction)) {
    const tag = tagOf(facet);
    if (tag === 'xs:annotation' || tag === '#text') continue;
    const value = attrsOf(facet)['@value'];
    if (value === undefined) throw new CodegenError(`Facet ${tag} of ${name} has no value`);

    if (tag === 'xs:enumeration') enumValues.push(value);
    else if (tag === 'xs:pattern') ownFacets.pattern = value;
    else if (NUMERIC_FACETS.has(tag)) {
      const field = tag.slice('xs:'.length) as 'length';
      ownFacets[field] = Number(value);
    } else if (STRING_FACETS.has(tag)) {
      const field = tag.slice('xs:'.length) as 'minInclusive';
      ownFacets[field] = value;
    } else {
      throw new CodegenError(`Unsupported facet ${tag} on ${name}`);
    }
  }
  if (enumValues.length > 0) ownFacets.enumValues = enumValues;

  return {
    def: { kind: 'simple', key: `${ns}:${name}`, ns, name, doc: docOf(node), baseKey },
    baseKey,
    ownFacets,
  };
}

/**
 * Collapse a restriction chain into effective facets.
 *
 * Where a pattern appears at several levels of the chain, XSD intersects them,
 * which is not expressible as a single regular expression. The most derived
 * pattern is always the narrower one in these schemas (`TaxpayerIdType` adds
 * `[0-9]{8}` to a generic 8-character string), so it is the one kept.
 */
function resolveSimpleType(key: string, rawSimple: Map<string, RawSimpleType>): SimpleTypeDef {
  const chain: RawSimpleType[] = [];
  let cursor: string | undefined = key;
  const seen = new Set<string>();

  while (cursor !== undefined && !PRIMITIVES[cursor]) {
    if (seen.has(cursor)) throw new CodegenError(`Cyclic simple type chain at ${cursor}`);
    seen.add(cursor);
    const raw = rawSimple.get(cursor);
    if (!raw) throw new CodegenError(`Simple type ${cursor} referenced but not defined`);
    chain.push(raw);
    cursor = raw.baseKey;
  }

  const primitive = PRIMITIVES[cursor ?? ''];
  if (!primitive)
    throw new CodegenError(`Simple type ${key} does not resolve to a known primitive`);

  // Walk from the most generic to the most derived so narrower facets win.
  const facets: Facets = { primitive };
  for (const raw of chain.reverse()) {
    Object.assign(facets, raw.ownFacets);
  }

  const self = rawSimple.get(key);
  if (!self) throw new CodegenError(`Simple type ${key} disappeared while resolving`);
  return { ...self.def, facets };
}

function readComplexType(
  node: OrderedNode,
  ns: NsKey,
  name: string,
  scope: PrefixScope,
): ComplexTypeDef {
  const def: ComplexTypeDef = {
    kind: 'complex',
    key: `${ns}:${name}`,
    ns,
    name,
    doc: docOf(node),
    content: 'element',
    fields: [],
    choiceGroups: [],
    attributes: [],
  };

  for (const child of childrenOf(node)) {
    const tag = tagOf(child);
    switch (tag) {
      case 'xs:annotation':
      case '#text':
        break;
      case 'xs:sequence':
        readParticle(child, ns, scope, def);
        break;
      case 'xs:choice':
        readChoice(child, ns, scope, def);
        break;
      case 'xs:complexContent': {
        const extension = firstNamed(child, 'xs:extension');
        if (!extension) {
          throw new CodegenError(`${name}: complexContent without an extension is not supported`);
        }
        const base = attrsOf(extension)['@base'];
        if (!base) throw new CodegenError(`${name}: extension without a base`);
        def.extendsKey = scope.resolve(base);
        for (const inner of childrenOf(extension)) {
          const innerTag = tagOf(inner);
          if (innerTag === 'xs:sequence') readParticle(inner, ns, scope, def);
          else if (innerTag === 'xs:choice') readChoice(inner, ns, scope, def);
          else if (innerTag !== 'xs:annotation' && innerTag !== '#text') {
            throw new CodegenError(`${name}: unsupported extension content ${innerTag}`);
          }
        }
        break;
      }
      case 'xs:simpleContent': {
        const extension = firstNamed(child, 'xs:extension');
        if (!extension) {
          throw new CodegenError(`${name}: simpleContent without an extension is not supported`);
        }
        const base = attrsOf(extension)['@base'];
        if (!base) throw new CodegenError(`${name}: simpleContent extension without a base`);
        def.content = 'simple';
        def.contentTypeKey = scope.resolve(base);
        for (const attribute of childrenNamed(extension, 'xs:attribute')) {
          def.attributes.push(readAttribute(attribute, scope));
        }
        break;
      }
      default:
        throw new CodegenError(`${name}: unsupported complexType content ${tag}`);
    }
  }

  return def;
}

function readAttribute(node: OrderedNode, scope: PrefixScope): AttributeDef {
  const attrs = attrsOf(node);
  const name = attrs['@name'];
  const type = attrs['@type'];
  if (!name || !type) throw new CodegenError('Attribute without a name or type');
  return {
    name,
    typeKey: scope.resolve(type),
    required: attrs['@use'] === 'required',
    doc: docOf(node),
  };
}

/** Read an `xs:sequence`, which may itself contain nested choices. */
function readParticle(node: OrderedNode, ns: NsKey, scope: PrefixScope, def: ComplexTypeDef): void {
  for (const child of childrenOf(node)) {
    const tag = tagOf(child);
    if (tag === 'xs:element') def.fields.push(readField(child, ns, scope));
    else if (tag === 'xs:choice') readChoice(child, ns, scope, def);
    else if (tag !== 'xs:annotation' && tag !== '#text') {
      throw new CodegenError(`${def.name}: unsupported particle content ${tag}`);
    }
  }
}

function readChoice(node: OrderedNode, ns: NsKey, scope: PrefixScope, def: ComplexTypeDef): void {
  const members: string[] = [];
  let anyOptionalMember = false;

  for (const child of childrenOf(node)) {
    const tag = tagOf(child);
    if (tag === 'xs:annotation' || tag === '#text') continue;
    if (tag !== 'xs:element') {
      throw new CodegenError(`${def.name}: unsupported choice content ${tag}`);
    }
    const field = readField(child, ns, scope);
    if (field.minOccurs === 0) anyOptionalMember = true;
    // Only one member may appear, so no member can be structurally required.
    def.fields.push({ ...field, minOccurs: 0 });
    members.push(field.name);
  }

  const choiceOptional = attrsOf(node)['@minOccurs'] === '0';
  def.choiceGroups.push({ members, required: !choiceOptional && !anyOptionalMember });
}

function readField(node: OrderedNode, ns: NsKey, scope: PrefixScope): FieldDef {
  const attrs = attrsOf(node);
  const name = attrs['@name'];
  const type = attrs['@type'];
  if (!name) throw new CodegenError('Element without a name');
  if (!type) {
    throw new CodegenError(
      `Element ${name} has no type (inline nested types are only supported at the document root)`,
    );
  }
  const maxRaw = attrs['@maxOccurs'];
  return {
    name,
    ns,
    typeKey: scope.resolve(type),
    minOccurs: attrs['@minOccurs'] === undefined ? 1 : Number(attrs['@minOccurs']),
    maxOccurs: maxRaw === undefined ? 1 : maxRaw === 'unbounded' ? null : Number(maxRaw),
    doc: docOf(node),
  };
}

/**
 * Inline the fields of extended base types.
 *
 * XSD places base content before extension content, and every NAV response
 * type extends `BasicResponseType`, so flattening here means the serialiser
 * never has to walk an inheritance chain to know element order.
 */
function flattenExtensions(types: Map<string, TypeDef>): void {
  const done = new Set<string>();

  const flatten = (key: string, stack: string[] = []): void => {
    if (done.has(key)) return;
    if (stack.includes(key))
      throw new CodegenError(`Cyclic extension chain: ${stack.join(' -> ')}`);
    const def = types.get(key);
    if (!def || def.kind !== 'complex') {
      done.add(key);
      return;
    }
    if (def.extendsKey) {
      flatten(def.extendsKey, [...stack, key]);
      const base = types.get(def.extendsKey);
      if (!base) throw new CodegenError(`${key} extends unknown type ${def.extendsKey}`);
      if (base.kind !== 'complex') {
        throw new CodegenError(`${key} extends non-complex type ${def.extendsKey}`);
      }
      def.fields = [...base.fields, ...def.fields];
      def.choiceGroups = [...base.choiceGroups, ...def.choiceGroups];
      def.attributes = [...base.attributes, ...def.attributes];
      if (base.content === 'simple') {
        def.content = 'simple';
        def.contentTypeKey = base.contentTypeKey;
      }
    }
    done.add(key);
  };

  for (const key of types.keys()) flatten(key);
}
