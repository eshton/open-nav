/** Base class for every error raised by the open-nav packages. */
export class NavError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * Raised when data fails local validation before a request is ever sent to
 * NAV — a malformed tax number, an unbalanced invoice, a bad `requestId`.
 */
export class NavValidationError extends NavError {
  /** Machine readable issues, in document order. */
  readonly issues: ValidationIssue[];

  constructor(message: string, issues: ValidationIssue[] = []) {
    super(issues.length > 0 ? `${message}: ${formatIssues(issues)}` : message);
    this.issues = issues;
  }
}

export interface ValidationIssue {
  /** Dotted path of the offending value, e.g. `invoiceLines.1.quantity`. */
  path: string;
  /** Human readable description of the problem. */
  message: string;
  /** Stable identifier so callers can branch on a specific rule. */
  code?: string;
}

function formatIssues(issues: ValidationIssue[]): string {
  return issues.map((issue) => `${issue.path || '<root>'} ${issue.message}`).join('; ');
}

/** Raised when the transport fails (DNS, TLS, timeout, connection reset). */
export class NavTransportError extends NavError {}

/**
 * Raised when NAV replies with a `GeneralErrorResponse`, or with any other
 * non-success HTTP status.
 */
export class NavApiError extends NavError {
  /** HTTP status code of the response. */
  readonly status: number;
  /** `result/funcCode`, e.g. `ERROR`. */
  readonly funcCode?: string;
  /** `result/errorCode`, e.g. `INVALID_SECURITY_USER`. */
  readonly errorCode?: string;
  /** Validation messages NAV attached to the error. */
  readonly validationMessages: NavValidationMessage[];
  /** Raw response body, kept for logging and bug reports. */
  readonly responseBody: string;

  constructor(init: {
    message: string;
    status: number;
    funcCode?: string;
    errorCode?: string;
    validationMessages?: NavValidationMessage[];
    responseBody?: string;
  }) {
    super(init.message);
    this.status = init.status;
    this.funcCode = init.funcCode;
    this.errorCode = init.errorCode;
    this.validationMessages = init.validationMessages ?? [];
    this.responseBody = init.responseBody ?? '';
  }
}

export interface NavValidationMessage {
  /** `ERROR` blocks processing, `WARN` does not. */
  validationResultCode: 'ERROR' | 'WARN' | 'INFO' | string;
  validationErrorCode?: string;
  message?: string;
  /** Only present on technical validation messages. */
  lineNumber?: number;
  /** Only present on business validation messages. */
  tag?: string;
  value?: string;
}

/**
 * Raised when an invoice batch was accepted by NAV but at least one invoice
 * was rejected during processing.
 */
export class NavInvoiceRejectedError extends NavError {
  readonly transactionId: string;
  readonly rejected: Array<{
    index: number;
    invoiceStatus: string;
    messages: NavValidationMessage[];
  }>;

  constructor(transactionId: string, rejected: NavInvoiceRejectedError['rejected']) {
    const detail = rejected
      .map((entry) => {
        const reasons = entry.messages
          .map((m) => [m.validationErrorCode, m.message].filter(Boolean).join(': '))
          .join(' | ');
        return `#${entry.index} ${entry.invoiceStatus}${reasons ? ` (${reasons})` : ''}`;
      })
      .join('; ');
    super(`Transaction ${transactionId} contains rejected invoices: ${detail}`);
    this.transactionId = transactionId;
    this.rejected = rejected;
  }
}
