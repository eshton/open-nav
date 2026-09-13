import { ROOTS, TYPES } from '../generated/schema.js';
import { XS_PRIMITIVES } from '../xml/descriptor.js';
import type { IssueCollector } from './issue.js';
import { createSchemaValidator } from './schema-validator.js';

export * from './schema-validator.js';

const validate = createSchemaValidator({
  types: TYPES,
  roots: ROOTS,
  xsPrimitives: XS_PRIMITIVES,
});

/**
 * Validate an Online Számla document against the schema, using the generated
 * descriptors. NAV reports all of these as `SCHEMA_VIOLATION`, except a missing
 * mandatory element which it reports as `MANDATORY_CONTENT_MISSING`.
 */
export function collectSchemaIssues(
  rootName: string,
  value: unknown,
  collector: IssueCollector,
): void {
  validate(rootName, value, collector);
}
