import { ROOTS, TYPES } from '../generated/schema.js';
import { Decimal } from '../money/decimal.js';
import { XS_PRIMITIVES, type PrimitiveKind, type SimpleDescriptor } from '../xml/descriptor.js';
import { IssueCollector } from './issue.js';

/**
 * Validate a document against the schema, using the generated descriptors.
 *
 * This covers what an XSD validator would: mandatory elements, value
 * constraints, cardinality and choice exclusivity. Doing it from the same
 * descriptor table that drives serialisation means the two cannot disagree,
 * and it needs no native XML library.
 *
 * NAV reports all of these as `SCHEMA_VIOLATION`, except a missing mandatory
 * element which it reports as `MANDATORY_CONTENT_MISSING`.
 */
export function collectSchemaIssues(
  rootName: string,
  value: unknown,
  collector: IssueCollector,
): void {
  const root = ROOTS[rootName];
  if (!root) {
    collector.error('SCHEMA_VIOLATION', '', `unknown document root ${rootName}`);
    return;
  }
  walk(root.type, value, '', collector);
}

function walk(typeKey: string, value: unknown, path: string, collector: IssueCollector): void {
  const primitive = XS_PRIMITIVES[typeKey];
  if (primitive) {
    checkPrimitive(primitive, undefined, value, path, collector);
    return;
  }

  const descriptor = TYPES[typeKey];
  if (!descriptor) {
    collector.error('SCHEMA_VIOLATION', path, `unknown type ${typeKey}`);
    return;
  }

  if (descriptor.kind === 'simple') {
    checkPrimitive(descriptor.primitive, descriptor, value, path, collector);
    return;
  }

  if (descriptor.content === 'simple') {
    if (!isRecord(value)) {
      collector.error('SCHEMA_VIOLATION', path, `expected an object, got ${describe(value)}`);
      return;
    }
    const contentType = descriptor.contentType;
    if (contentType) walk(contentType, value['value'], `${path}.value`, collector);
    for (const attribute of descriptor.attributes ?? []) {
      const attributeValue = value[attribute.name];
      if (attributeValue === undefined || attributeValue === null) {
        if (attribute.required) {
          collector.error(
            'MANDATORY_CONTENT_MISSING',
            `${path}@${attribute.name}`,
            'attribute is required',
          );
        }
        continue;
      }
      walk(attribute.type, attributeValue, `${path}@${attribute.name}`, collector);
    }
    return;
  }

  if (!isRecord(value)) {
    collector.error('SCHEMA_VIOLATION', path, `expected an object, got ${describe(value)}`);
    return;
  }

  for (const field of descriptor.fields) {
    const fieldPath = path ? `${path}.${field.name}` : field.name;
    const fieldValue = value[field.name];

    if (fieldValue === undefined || fieldValue === null) {
      if (!field.optional) {
        collector.error('MANDATORY_CONTENT_MISSING', fieldPath, 'is required');
      }
      continue;
    }

    if (field.repeated) {
      if (!Array.isArray(fieldValue)) {
        collector.error('SCHEMA_VIOLATION', fieldPath, 'is repeatable and expects an array');
        continue;
      }
      if (fieldValue.length === 0) {
        if (!field.optional) {
          collector.error('MANDATORY_CONTENT_MISSING', fieldPath, 'must have at least one entry');
        }
        continue;
      }
      if (field.maxOccurs !== undefined && fieldValue.length > field.maxOccurs) {
        collector.error(
          'SCHEMA_VIOLATION',
          fieldPath,
          `allows at most ${field.maxOccurs} entries, got ${fieldValue.length}`,
        );
      }
      for (const [index, item] of fieldValue.entries()) {
        walk(field.type, item, `${fieldPath}.${index}`, collector);
      }
      continue;
    }

    if (Array.isArray(fieldValue)) {
      collector.error('SCHEMA_VIOLATION', fieldPath, 'occurs at most once');
      continue;
    }

    walk(field.type, fieldValue, fieldPath, collector);
  }

  for (const key of Object.keys(value)) {
    if (!descriptor.fields.some((field) => field.name === key)) {
      const isAttribute = (descriptor.attributes ?? []).some((attribute) => attribute.name === key);
      if (!isAttribute) {
        collector.error(
          'SCHEMA_VIOLATION',
          path ? `${path}.${key}` : key,
          `is not part of ${descriptor.name}`,
        );
      }
    }
  }

  // Choice groups: NAV nests these inside sequences, so they are checked
  // against the flattened field list rather than by structural position.
  for (const group of descriptor.choiceGroups ?? []) {
    const present = group.members.filter(
      (member) => value[member] !== undefined && value[member] !== null,
    );
    if (present.length > 1) {
      collector.error(
        'SCHEMA_VIOLATION',
        path,
        `only one of ${group.members.join(', ')} may be set, found ${present.join(' and ')}`,
      );
    } else if (present.length === 0 && group.required) {
      collector.error(
        'MANDATORY_CONTENT_MISSING',
        path,
        `one of ${group.members.join(', ')} is required`,
      );
    }
  }
}

function checkPrimitive(
  kind: PrimitiveKind,
  descriptor: SimpleDescriptor | undefined,
  value: unknown,
  path: string,
  collector: IssueCollector,
): void {
  switch (kind) {
    case 'boolean':
      if (typeof value !== 'boolean') {
        collector.error('SCHEMA_VIOLATION', path, `expected a boolean, got ${describe(value)}`);
      }
      return;

    case 'integer': {
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        collector.error('SCHEMA_VIOLATION', path, `expected an integer, got ${describe(value)}`);
        return;
      }
      // Numeric comparison, not lexicographic: '2' sorts after '100' as text.
      checkBounds(String(value), descriptor, path, collector, true);
      if (descriptor?.totalDigits !== undefined) {
        const digits = Math.abs(value).toString().length;
        if (digits > descriptor.totalDigits) {
          collector.error(
            'SCHEMA_VIOLATION',
            path,
            `has ${digits} digits, at most ${descriptor.totalDigits} allowed`,
          );
        }
      }
      return;
    }

    case 'decimal': {
      if (typeof value !== 'string' && typeof value !== 'number') {
        collector.error('SCHEMA_VIOLATION', path, `expected a decimal, got ${describe(value)}`);
        return;
      }
      let amount: Decimal;
      try {
        amount = Decimal.from(value);
      } catch {
        collector.error('SCHEMA_VIOLATION', path, `${JSON.stringify(value)} is not a decimal`);
        return;
      }
      if (descriptor?.fractionDigits !== undefined && amount.scale > descriptor.fractionDigits) {
        collector.error(
          'SCHEMA_VIOLATION',
          path,
          `has ${amount.scale} decimal places, at most ${descriptor.fractionDigits} allowed`,
        );
      }
      if (descriptor?.totalDigits !== undefined && amount.totalDigits() > descriptor.totalDigits) {
        collector.error(
          'SCHEMA_VIOLATION',
          path,
          `has ${amount.totalDigits()} significant digits, at most ${descriptor.totalDigits} allowed`,
        );
      }
      checkBounds(amount.toString(), descriptor, path, collector, true);
      return;
    }

    default: {
      if (typeof value !== 'string') {
        collector.error('SCHEMA_VIOLATION', path, `expected a string, got ${describe(value)}`);
        return;
      }
      if (!descriptor) return;
      if (descriptor.enumValues && !descriptor.enumValues.includes(value)) {
        collector.error(
          'SCHEMA_VIOLATION',
          path,
          `${JSON.stringify(value)} is not one of ${descriptor.enumValues.join(', ')}`,
        );
      }
      if (descriptor.length !== undefined && value.length !== descriptor.length) {
        collector.error(
          'SCHEMA_VIOLATION',
          path,
          `must be exactly ${descriptor.length} characters, got ${value.length}`,
        );
      }
      if (descriptor.minLength !== undefined && value.length < descriptor.minLength) {
        collector.error(
          'SCHEMA_VIOLATION',
          path,
          `must be at least ${descriptor.minLength} characters, got ${value.length}`,
        );
      }
      if (descriptor.maxLength !== undefined && value.length > descriptor.maxLength) {
        collector.error(
          'SCHEMA_VIOLATION',
          path,
          `must be at most ${descriptor.maxLength} characters, got ${value.length}`,
        );
      }
      if (descriptor.pattern !== undefined && !anchored(descriptor.pattern).test(value)) {
        collector.error(
          'SCHEMA_VIOLATION',
          path,
          `${JSON.stringify(value)} does not match ${descriptor.pattern}`,
        );
      }
      // Dates and timestamps carry their bounds as text, and NAV's are all
      // lexicographically comparable ISO forms.
      checkBounds(value, descriptor, path, collector);
      return;
    }
  }
}

function checkBounds(
  value: string,
  descriptor: SimpleDescriptor | undefined,
  path: string,
  collector: IssueCollector,
  numeric = false,
): void {
  if (!descriptor) return;
  const compare = numeric
    ? (left: string, right: string) => Decimal.from(left).compare(right)
    : (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

  const checks: Array<[keyof SimpleDescriptor, (result: number) => boolean, string]> = [
    ['minInclusive', (result) => result < 0, 'must not be less than'],
    ['maxInclusive', (result) => result > 0, 'must not be greater than'],
    ['minExclusive', (result) => result <= 0, 'must be greater than'],
    ['maxExclusive', (result) => result >= 0, 'must be less than'],
  ];

  for (const [facet, violates, wording] of checks) {
    const bound = descriptor[facet];
    if (typeof bound !== 'string') continue;
    if (violates(compare(value, bound))) {
      collector.error('SCHEMA_VIOLATION', path, `${wording} ${bound}, got ${value}`);
    }
  }
}

const anchoredCache = new Map<string, RegExp>();

/** XSD patterns match the whole value, unlike JavaScript regular expressions. */
function anchored(pattern: string): RegExp {
  const cached = anchoredCache.get(pattern);
  if (cached) return cached;
  const compiled = new RegExp(`^(?:${pattern})$`, 'u');
  anchoredCache.set(pattern, compiled);
  return compiled;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeof value;
}
