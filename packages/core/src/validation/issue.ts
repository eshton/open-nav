import type { NavFaultCode } from '../generated/fault-codes.js';
import { NAV_FAULT_MESSAGES } from '../generated/fault-codes.js';

/**
 * How much a finding matters.
 *
 * `error` means NAV would reject the report. `warning` means the data is
 * accepted but suspect — a tax number whose check digit is wrong, say, which
 * NAV validates against its taxpayer registry rather than arithmetically.
 * Keeping the two apart is what makes the validator usable: a validator that
 * cries wolf gets switched off.
 */
export type Severity = 'error' | 'warning';

/**
 * Findings this library reports that NAV has no code for.
 *
 * Kept separate from NAV's codes rather than forced into an approximate one,
 * so it is always clear whether a finding means "the service would say this"
 * or "we noticed this".
 */
export type LocalFaultCode =
  /** A tax number's check digit does not match. NAV checks its registry instead. */
  | 'LOCAL_TAXPAYER_ID_CHECK_DIGIT'
  /** A county code outside the set NAV is known to issue. */
  | 'LOCAL_COUNTY_CODE_UNKNOWN'
  /** A VAT percentage that is not a current Hungarian rate. */
  | 'LOCAL_VAT_PERCENTAGE_UNUSUAL';

export type FaultCode = NavFaultCode | LocalFaultCode;

export interface InvoiceValidationIssue {
  /**
   * The fault code. Where NAV defines one it is used verbatim, so a local
   * failure names exactly what the service would have said, and the compiler
   * checks it against the generated catalogue.
   */
  code: FaultCode;
  /** `nav` for a code NAV defines, `local` for one of ours. */
  origin: 'nav' | 'local';
  severity: Severity;
  /** Dotted path to the offending value, e.g. `invoiceLines.line.2.quantity`. */
  path: string;
  /** What is wrong, with the offending values quoted. */
  message: string;
  /** NAV's own description of the fault, in the requested language. */
  navMessage?: string;
}

export interface ValidationReport {
  /** True when there are no errors. Warnings do not make a report invalid. */
  valid: boolean;
  errors: InvoiceValidationIssue[];
  warnings: InvoiceValidationIssue[];
  /** Everything, in the order found. */
  issues: InvoiceValidationIssue[];
}

export type MessageLanguage = 'en' | 'hu' | 'de';

/** Collects findings while rules run, then assembles the report. */
export class IssueCollector {
  private readonly collected: InvoiceValidationIssue[] = [];

  constructor(private readonly language: MessageLanguage = 'en') {}

  add(code: FaultCode, severity: Severity, path: string, message: string): void {
    const navMessage = isNavCode(code) ? NAV_FAULT_MESSAGES[code][this.language] : undefined;
    this.collected.push({
      code,
      origin: isNavCode(code) ? 'nav' : 'local',
      severity,
      path,
      message,
      ...(navMessage ? { navMessage } : {}),
    });
  }

  error(code: FaultCode, path: string, message: string): void {
    this.add(code, 'error', path, message);
  }

  warn(code: FaultCode, path: string, message: string): void {
    this.add(code, 'warning', path, message);
  }

  report(): ValidationReport {
    const errors = this.collected.filter((issue) => issue.severity === 'error');
    const warnings = this.collected.filter((issue) => issue.severity === 'warning');
    return { valid: errors.length === 0, errors, warnings, issues: [...this.collected] };
  }
}

/** Whether a code is one NAV defines, as opposed to one of ours. */
export function isNavCode(code: FaultCode): code is NavFaultCode {
  return code in NAV_FAULT_MESSAGES;
}

/** NAV's description of a fault code, for surfacing in your own UI. */
export function faultMessage(code: FaultCode, language: MessageLanguage = 'en'): string {
  return isNavCode(code) ? (NAV_FAULT_MESSAGES[code][language] ?? '') : '';
}
