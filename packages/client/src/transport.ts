import {
  NavApiError,
  NavTransportError,
  parseDocument,
  type NavValidationMessage,
} from '@open-nav/core';

export interface TransportOptions {
  /** Injectable for testing and for runtimes with a custom fetch. */
  fetch?: typeof globalThis.fetch;
  /** Per-attempt timeout in milliseconds. Defaults to 30 000. */
  timeoutMs?: number;
  /**
   * Retries for transport failures and 5xx responses. Defaults to 2.
   *
   * Only idempotent failures are retried: a `manageInvoice` that reached NAV
   * must never be resent, because the `requestId` would be rejected as a
   * replay and, worse, a genuinely delivered batch could be duplicated.
   */
  retries?: number;
  /** Extra headers, e.g. a correlation id for your own logs. */
  headers?: Record<string, string>;
}

export interface NavResponse {
  root: string;
  value: unknown;
  status: number;
  body: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRIES = 2;

/** POST an XML request to a NAV operation and parse the response. */
export async function postXml(
  baseUrl: string,
  operation: string,
  xml: string,
  options: TransportOptions = {},
  retryable = true,
): Promise<NavResponse> {
  const doFetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const attempts = retryable ? (options.retries ?? DEFAULT_RETRIES) + 1 : 1;
  const url = `${baseUrl.replace(/\/+$/, '')}/${operation}`;

  let lastError: unknown;
  let retryAfterMs: number | undefined;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) {
      // 500ms, 1s, 2s ... NAV rate limits per taxpayer, so backing off is
      // both polite and necessary. A Retry-After header overrides the curve.
      await delay(retryAfterMs ?? 500 * 2 ** (attempt - 1));
      retryAfterMs = undefined;
    }

    let response: Response;
    try {
      response = await withTimeout(
        (signal) =>
          doFetch(url, {
            method: 'POST',
            body: xml,
            signal,
            headers: {
              'content-type': 'application/xml; charset=utf-8',
              accept: 'application/xml',
              ...options.headers,
            },
          }),
        timeoutMs,
      );
    } catch (cause) {
      lastError = new NavTransportError(`${operation} request to NAV failed`, { cause });
      continue;
    }

    const body = await response.text();

    if (response.ok) {
      return { ...parseResponseBody(body, response.status), status: response.status, body };
    }

    const error = toApiError(body, response.status);

    // 429 and 503 are "later, not never": back off for as long as NAV asks.
    // A bulk download makes one request per invoice, so this is the difference
    // between a pull that finishes and one that dies a third of the way in.
    if (response.status === 429 || response.status === 503) {
      lastError = error;
      retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
      continue;
    }

    // Any other 4xx is a decision by NAV and will not change on retry.
    if (response.status < 500 || response.status === 501) throw error;
    lastError = error;
  }

  throw lastError instanceof Error
    ? lastError
    : new NavTransportError(`${operation} request to NAV failed`);
}

function parseResponseBody(body: string, status: number): { root: string; value: unknown } {
  try {
    // NAV may deploy schema additions ahead of the published XSDs, and a new
    // optional element must not break an otherwise successful response.
    return parseDocument(body, { unknownElements: 'ignore' });
  } catch (cause) {
    throw new NavApiError({
      message: `NAV returned a response that could not be parsed: ${(cause as Error).message}`,
      status,
      responseBody: body,
    });
  }
}

/**
 * Turn an error body into a typed error.
 *
 * NAV signals failure with `GeneralErrorResponse` (Online Számla specific,
 * carrying technical validation messages) or `GeneralExceptionResponse` (the
 * NTCA-wide shape, used for malformed requests). Both are handled, and so is
 * a body that is neither — a gateway HTML page, for instance.
 */
function toApiError(body: string, status: number): NavApiError {
  let parsed: { root: string; value: unknown } | undefined;
  try {
    parsed = parseDocument(body, { unknownElements: 'ignore' });
  } catch {
    parsed = undefined;
  }

  if (!parsed) {
    return new NavApiError({
      message: `NAV returned HTTP ${status} with an unrecognised body`,
      status,
      responseBody: body,
    });
  }

  const value = parsed.value as {
    result?: { funcCode?: string; errorCode?: string; message?: string };
    funcCode?: string;
    errorCode?: string;
    message?: string;
    technicalValidationMessages?: NavValidationMessage[];
  };
  const result = value.result ?? value;
  const parts = [result.errorCode, result.message].filter(Boolean);

  return new NavApiError({
    message:
      parts.length > 0
        ? `NAV rejected the request: ${parts.join(' - ')}`
        : `NAV returned HTTP ${status} (${parsed.root})`,
    status,
    funcCode: result.funcCode,
    errorCode: result.errorCode,
    validationMessages: value.technicalValidationMessages ?? [],
    responseBody: body,
  });
}

async function withTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Read a `Retry-After` header, which may be seconds or an HTTP date.
 *
 * Capped, because a header asking us to wait an hour would hang a download
 * that the caller would rather see fail.
 */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();

  if (/^\d+$/.test(trimmed)) {
    return Math.min(Number(trimmed) * 1000, MAX_RETRY_AFTER_MS);
  }
  const timestamp = Date.parse(trimmed);
  if (Number.isNaN(timestamp)) return undefined;
  return Math.min(Math.max(timestamp - now, 0), MAX_RETRY_AFTER_MS);
}

const MAX_RETRY_AFTER_MS = 60_000;
