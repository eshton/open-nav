import {
  IssueCollector,
  createSchemaValidator,
  type MessageLanguage,
  type ValidationReport,
} from '@open-nav/core';
import { ROOTS, TYPES } from './generated/schema.js';
import { XS_PRIMITIVES } from './xml/descriptor.js';
import type { VatDeclarationData } from './generated/types.js';

const validateSchema = createSchemaValidator({
  types: TYPES,
  roots: ROOTS,
  xsPrimitives: XS_PRIMITIVES,
});

export interface ValidateDeclarationOptions {
  /** Language for NAV's own fault descriptions. Defaults to English. */
  language?: MessageLanguage;
}

/**
 * Validate a VAT declaration's analytics locally before submitting.
 *
 * Runs the same descriptor-driven checks NAV's XSD validation would — mandatory
 * elements, value constraints (enums, patterns, lengths, digit and bound
 * facets), cardinality and choice exclusivity — reported with NAV's shared
 * `SCHEMA_VIOLATION` / `MANDATORY_CONTENT_MISSING` codes, so a formal error is
 * caught before the upload round trip.
 *
 * This is the schema layer only. eVAT business rules (e.g. tax-code and
 * return-row consistency) are decidable but need their own fault-code mapping;
 * they are a later addition, so callers should still expect NAV's server-side
 * pre-verification to have the final say.
 *
 * ```ts
 * const report = validateDeclaration(declaration);
 * if (!report.valid) console.error(report.errors);
 * ```
 */
export function validateDeclaration(
  declaration: VatDeclarationData,
  options: ValidateDeclarationOptions = {},
): ValidationReport {
  const collector = new IssueCollector(options.language ?? 'en');
  validateSchema('VatDeclarationData', declaration, collector);
  return collector.report();
}
