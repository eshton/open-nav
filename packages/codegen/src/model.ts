/**
 * The subset of XML Schema that the NAV schemas actually use.
 *
 * This is deliberately not a general purpose XSD model. The generator throws
 * on any construct outside this set, so an unexpected upstream schema change
 * fails the build instead of silently producing wrong code.
 */

/** Short key for each namespace the Online Számla schemas span. */
export type NsKey = 'common' | 'base' | 'data' | 'api' | 'annul' | 'metrics';

export const NAMESPACES: Record<NsKey, string> = {
  common: 'http://schemas.nav.gov.hu/NTCA/1.0/common',
  base: 'http://schemas.nav.gov.hu/OSA/3.0/base',
  data: 'http://schemas.nav.gov.hu/OSA/3.0/data',
  api: 'http://schemas.nav.gov.hu/OSA/3.0/api',
  annul: 'http://schemas.nav.gov.hu/OSA/3.0/annul',
  metrics: 'http://schemas.nav.gov.hu/OSA/3.0/metrics',
};

/** How a simple type's value is carried on the wire. */
export type PrimitiveKind =
  'string' | 'decimal' | 'integer' | 'boolean' | 'date' | 'dateTime' | 'base64Binary';

/** Bilingual documentation lifted from `xs:documentation`. */
export interface Doc {
  hu?: string;
  en?: string;
}

/**
 * Effective constraints of a simple type, with the restriction chain already
 * collapsed. NAV nests restrictions several levels deep
 * (`TaxpayerIdType` → `AtomicStringType8` → `xs:string`); resolving at
 * generation time keeps the runtime validator a flat facet check.
 */
export interface Facets {
  primitive: PrimitiveKind;
  enumValues?: string[];
  /** Most derived `xs:pattern`. See `resolveFacets` for why only one. */
  pattern?: string;
  length?: number;
  minLength?: number;
  maxLength?: number;
  totalDigits?: number;
  fractionDigits?: number;
  minInclusive?: string;
  maxInclusive?: string;
  minExclusive?: string;
  maxExclusive?: string;
}

export interface SimpleTypeDef {
  kind: 'simple';
  /** `${nsKey}:${name}`, e.g. `common:TaxpayerIdType`. */
  key: string;
  ns: NsKey;
  name: string;
  doc: Doc;
  /** Type key this restricts, for traceability. */
  baseKey: string;
  facets: Facets;
}

/** A child element inside a `sequence` or `choice`. */
export interface FieldDef {
  name: string;
  /**
   * Namespace the element belongs to. With `elementFormDefault="qualified"`
   * this is the target namespace of the schema that *declares* it — which is
   * why a `supplierTaxNumber` in the data namespace has `taxpayerId` children
   * in the base namespace.
   */
  ns: NsKey;
  typeKey: string;
  minOccurs: number;
  /** `null` means `unbounded`. */
  maxOccurs: number | null;
  doc: Doc;
}

export interface AttributeDef {
  name: string;
  typeKey: string;
  required: boolean;
  doc: Doc;
}

/**
 * A set of elements of which at most one may appear.
 *
 * NAV uses `xs:choice` both as a whole complex type's content and nested
 * inside a sequence, so choice members are flattened into the ordered field
 * list and the exclusivity is recorded separately. That keeps serialisation a
 * single ordered walk while still letting the validator reject
 * `vatPercentage` and `vatExemption` being set at once.
 */
export interface ChoiceGroup {
  /** Field names belonging to the group, in schema order. */
  members: string[];
  /**
   * `true` when exactly one member must be present, `false` when at most one
   * may be. A group is only required when the `xs:choice` itself is required
   * *and* no member declares `minOccurs="0"`.
   */
  required: boolean;
}

export interface ComplexTypeDef {
  kind: 'complex';
  key: string;
  ns: NsKey;
  name: string;
  doc: Doc;
  /**
   * `element` — a flat ordered field list, the normal case.
   * `simple` — a text value plus attributes (`common:CryptoType`).
   */
  content: 'element' | 'simple';
  /** Every child element, in document order, choice members included. */
  fields: FieldDef[];
  /** Exclusivity constraints over `fields`. */
  choiceGroups: ChoiceGroup[];
  attributes: AttributeDef[];
  /** For `content: 'simple'`: type key of the text value. */
  contentTypeKey?: string;
  /** Base type this extends, already flattened into `fields`. */
  extendsKey?: string;
}

export type TypeDef = SimpleTypeDef | ComplexTypeDef;

/** A globally declared element — the document root of a request or response. */
export interface RootElementDef {
  name: string;
  ns: NsKey;
  typeKey: string;
  doc: Doc;
}

export interface SchemaModel {
  types: Map<string, TypeDef>;
  roots: RootElementDef[];
}

export class CodegenError extends Error {}
