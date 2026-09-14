import { NavApiError, NavTransportError } from '../errors.js';

/**
 * Shared HTTP plumbing for the NAV M2M clients (Online Számla, eÁFA, eNyugta).
 *
 * Each service package binds its own generated codec's `parseDocument`, but the
 * request/response mechanics are identical: a timed `fetch`, mapping NAV's error
 * verdict to {@link NavApiError} / {@link NavTransportError}, and reading the
 * `multipart/form-data` downloads NAV answers with. Keeping one copy here stops
 * the per-package transports from drifting (they did). Pure web APIs only —
 * no Node built-ins — so this stays usable on workers.
 */

/** A parsed NAV response: the root element name, its value, and the raw HTTP. */
export interface NavHttpResponse {
  root: string;
  value: unknown;
  status: number;
  body: string;
}

/** Parse a response body into a root name + value (a bound generated codec). */
export type NavParseFn = (body: string) => { root: string; value: unknown };

export interface InterpretOptions {
  /** Message prefix, e.g. `eVAT queryDeclarationList` or `eNyugta request`. */
  label: string;
  parse: NavParseFn;
}

/**
 * Turn a raw response into a {@link NavHttpResponse}, or throw the right NAV
 * error: `NavApiError` on an `ERROR` verdict or HTTP >= 300, `NavTransportError`
 * when a 2xx body will not parse.
 */
export function interpretNavResponse(
  body: string,
  status: number,
  options: InterpretOptions,
): NavHttpResponse {
  let root: string;
  let value: unknown;
  try {
    const parsed = options.parse(body);
    root = parsed.root;
    value = parsed.value;
  } catch (cause) {
    if (status >= 200 && status < 300) {
      throw new NavTransportError(
        `${options.label} returned an unparseable response: ${(cause as Error).message}`,
      );
    }
    throw new NavApiError({
      message: `${options.label} failed with HTTP ${status}`,
      status,
      responseBody: body,
    });
  }

  const result =
    value && typeof value === 'object'
      ? (value as { result?: { funcCode?: string; errorCode?: string; message?: string } }).result
      : undefined;
  if (result?.funcCode === 'ERROR' || status >= 300) {
    throw new NavApiError({
      message: result?.message ?? `${options.label} failed with HTTP ${status}`,
      status,
      funcCode: result?.funcCode,
      errorCode: result?.errorCode,
      responseBody: body,
    });
  }

  return { root, value, status, body };
}

/** Default per-request timeout, in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 60_000;

export interface TimeoutFetchOptions {
  /** Injectable for tests and custom runtimes. */
  fetch?: typeof globalThis.fetch;
  /** Per-request timeout in milliseconds. Defaults to {@link DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Message prefix for a failure/timeout, e.g. `eVAT queryDeclarationList`. */
  label: string;
}

/**
 * `fetch` with an abort-based timeout, mapping failures to `NavTransportError`.
 * A timeout is reported distinctly from a network error so callers can retry
 * only on a timeout.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  options: TimeoutFetchOptions,
): Promise<Response> {
  const doFetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await doFetch(url, { ...init, signal: controller.signal });
  } catch (cause) {
    throw new NavTransportError(
      (cause as Error).name === 'AbortError'
        ? `${options.label} timed out after ${timeoutMs}ms`
        : `${options.label} failed: ${(cause as Error).message}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

/** Strip trailing slashes from a base URL (ReDoS-safe, no regex). */
export function trimTrailingSlash(url: string): string {
  let trimmed = url;
  while (trimmed.endsWith('/')) trimmed = trimmed.slice(0, -1);
  return trimmed;
}

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, from: number): number {
  outer: for (let i = from; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/**
 * Split a `multipart/form-data` body into its parts by name, keeping binary
 * bodies intact.
 *
 * Scans for the boundary over the raw bytes (never materialising the whole body
 * as a string), because NAV's payload part carries no filename — so
 * `Response.formData()` would decode it as a UTF-8 string and corrupt binary
 * (e.g. gzip) content.
 */
export function parseMultipart(bytes: Uint8Array, boundary: string): Map<string, Uint8Array> {
  const encoder = new TextEncoder();
  const delimiter = encoder.encode(`--${boundary}`);
  const headerSep = encoder.encode('\r\n\r\n');
  const result = new Map<string, Uint8Array>();

  let index = indexOfBytes(bytes, delimiter, 0);
  while (index >= 0) {
    const start = index + delimiter.length;
    if (bytes[start] === 0x2d && bytes[start + 1] === 0x2d) break; // closing "--"
    const headerEnd = indexOfBytes(bytes, headerSep, start);
    if (headerEnd < 0) break;
    const headers = new TextDecoder('latin1').decode(bytes.subarray(start, headerEnd));
    const bodyStart = headerEnd + headerSep.length;
    const next = indexOfBytes(bytes, delimiter, bodyStart);
    if (next < 0) break;
    const body = bytes.subarray(bodyStart, next - 2); // drop the CRLF before the boundary
    const name = /name="([^"]*)"/i.exec(headers)?.[1];
    if (name) result.set(name, body);
    index = next;
  }
  return result;
}

/** True if the bytes begin with `<` (after an optional UTF-8 BOM). */
export function partLooksXml(bytes: Uint8Array): boolean {
  const offset = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  return bytes[offset] === 0x3c;
}

/** The first XML-looking part of a multipart body. */
export function firstXmlPart(parts: Map<string, Uint8Array>): Uint8Array | undefined {
  for (const bytes of parts.values()) if (partLooksXml(bytes)) return bytes;
  return undefined;
}

/** The first non-XML (binary) part of a multipart body. */
export function firstBinaryPart(parts: Map<string, Uint8Array>): Uint8Array | undefined {
  for (const bytes of parts.values()) if (!partLooksXml(bytes)) return bytes;
  return undefined;
}
