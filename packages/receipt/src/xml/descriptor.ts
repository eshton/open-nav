/**
 * Runtime description of the eNyugta (eReceipt) ERECEIPT schemas.
 *
 * The generated `TYPES` table in `../generated/schema.js` is the single source
 * of truth for element order, namespaces, cardinality, choice exclusivity and
 * value constraints. This mirrors `@open-nav/core`'s descriptor for the
 * ERECEIPT 1.1 namespaces (which also reuse the OSA invoice base/data
 * namespaces for the embedded invoice sub-schema); the packages are
 * deliberately independent so each moves to a new interface version by
 * regeneration alone.
 */

/** Short key for each namespace in the eNyugta (ERECEIPT 1.1) schemas. */
export type NsKey =
  | 'common'
  | 'base'
  | 'data'
  | 'ereceiptApi'
  | 'ereceiptBase'
  | 'ereceiptComm'
  | 'ereceiptDoc'
  | 'ereceiptDocMsg'
  | 'ereceiptReport';

export const NAMESPACE_URIS: Record<NsKey, string> = {
  common: 'http://schemas.nav.gov.hu/NTCA/1.0/common',
  base: 'http://schemas.nav.gov.hu/OSA/3.0/base',
  data: 'http://schemas.nav.gov.hu/OSA/3.0/data',
  ereceiptApi: 'http://schemas.nav.gov.hu/ERECEIPT/1.1/api',
  ereceiptBase: 'http://schemas.nav.gov.hu/ERECEIPT/1.1/base',
  ereceiptComm: 'http://schemas.nav.gov.hu/ERECEIPT/1.1/communicationData',
  ereceiptDoc: 'http://schemas.nav.gov.hu/ERECEIPT/1.1/documentData',
  ereceiptDocMsg: 'http://schemas.nav.gov.hu/ERECEIPT/1.1/documentMessage',
  ereceiptReport: 'http://schemas.nav.gov.hu/ERECEIPT/1.1/reportMessage',
};

/** How a value is carried in XML. */
export type PrimitiveKind =
  'string' | 'decimal' | 'integer' | 'boolean' | 'date' | 'dateTime' | 'base64Binary';

export interface FieldDescriptor {
  /** Element local name. */
  name: string;
  /** Namespace that *declares* this element, which may differ from its parent's. */
  ns: NsKey;
  /** Key into the `TYPES` table, or an `xs:` primitive. */
  type: string;
  /** `minOccurs="0"`. Choice members are always optional. */
  optional?: boolean;
  /** `maxOccurs` greater than one, or unbounded. */
  repeated?: boolean;
  /** Upper bound when the schema states a finite one. */
  maxOccurs?: number;
}

export interface ChoiceGroupDescriptor {
  members: string[];
  /** `true` when exactly one member must be present; `false` when at most one may be. */
  required: boolean;
}

export interface AttributeDescriptor {
  name: string;
  type: string;
  required: boolean;
}

export interface ComplexDescriptor {
  kind: 'complex';
  name: string;
  ns: NsKey;
  /** Name of the corresponding generated TypeScript type. */
  tsName: string;
  /** `element` for child elements, `simple` for text content plus attributes. */
  content: 'element' | 'simple';
  /** Type of the text value when `content` is `simple`. */
  contentType?: string;
  /** Child elements in schema order — which is the order NAV requires. */
  fields: FieldDescriptor[];
  choiceGroups?: ChoiceGroupDescriptor[];
  attributes?: AttributeDescriptor[];
}

export interface SimpleDescriptor {
  kind: 'simple';
  name: string;
  ns: NsKey;
  tsName: string;
  primitive: PrimitiveKind;
  /** Permitted values, when the type is an enumeration. */
  enumValues?: string[];
  /** Most derived `xs:pattern` of the restriction chain. */
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

export type Descriptor = ComplexDescriptor | SimpleDescriptor;

export interface RootDescriptor {
  name: string;
  ns: NsKey;
  type: string;
}

/** Primitive kinds of the `xs:` built-ins referenced directly by the schemas. */
export const XS_PRIMITIVES: Record<string, PrimitiveKind> = {
  'xs:string': 'string',
  'xs:decimal': 'decimal',
  'xs:int': 'integer',
  'xs:integer': 'integer',
  'xs:long': 'integer',
  'xs:nonNegativeInteger': 'integer',
  'xs:positiveInteger': 'integer',
  'xs:negativeInteger': 'integer',
  'xs:nonPositiveInteger': 'integer',
  'xs:boolean': 'boolean',
  'xs:date': 'date',
  'xs:dateTime': 'dateTime',
  'xs:base64Binary': 'base64Binary',
};
