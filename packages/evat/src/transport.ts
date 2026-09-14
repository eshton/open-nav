import { gunzipSync } from 'node:zlib';
import { NavApiError, NavTransportError } from '@open-nav/core';
import { parseDocument } from './codec.js';

export interface EvatTransportOptions {
  /** Injectable for testing and for runtimes with a custom fetch. */
  fetch?: typeof globalThis.fetch;
  /** Per-request timeout in milliseconds. Defaults to 60 000. */
  timeoutMs?: number;
  /** Extra headers, e.g. a correlation id for your own logs. */
  headers?: Record<string, string>;
}

export interface EvatResponse {
  root: string;
  value: unknown;
  status: number;
  body: string;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/** The `application/octet-stream` half of a multipart upload. */
export interface UploadPart {
  bytes: Uint8Array;
  /** File name for the octet-stream part's Content-Disposition. */
  fileName?: string;
}

/**
 * NAV part names for the two-message multipart uploads.
 *
 * Confirmed against the eÁFA test system (EVAT-10): NAV requires exactly two
 * parts named `body` (the `application/xml` request) and `file` (the
 * `application/octet-stream` payload). Sending any other name for the request
 * part is rejected with `INVALID_REQUEST` / `INVALID_PARTS`: "The multipart
 * request must contain 2 parts named \"body\" and \"file\"." Still configurable
 * via {@link EvatTransportOptions} should NAV ever change it.
 */
export const MULTIPART_FIELDS = { request: 'body', file: 'file' } as const;

/** POST an XML request to an eVAT operation and parse the response. */
export async function postXml(
  baseUrl: string,
  operation: string,
  xml: string,
  options: EvatTransportOptions = {},
): Promise<EvatResponse> {
  return send(baseUrl, operation, options, {
    body: xml,
    headers: { 'content-type': 'application/xml', accept: 'application/xml' },
  });
}

/**
 * POST a `multipart/form-data` upload (the request XML plus a binary payload)
 * to an eVAT file-upload operation and parse the response.
 */
export async function postMultipart(
  baseUrl: string,
  operation: string,
  xml: string,
  part: UploadPart,
  options: EvatTransportOptions = {},
  fields: { request: string; file: string } = MULTIPART_FIELDS,
): Promise<EvatResponse> {
  const form = new FormData();
  form.append(fields.request, new Blob([xml], { type: 'application/xml' }));
  form.append(
    fields.file,
    new Blob([part.bytes], { type: 'application/octet-stream' }),
    part.fileName ?? 'partition.bin',
  );
  // Let fetch set the multipart content-type with its boundary.
  return send(baseUrl, operation, options, {
    body: form,
    headers: { accept: 'multipart/form-data, application/xml' },
  });
}

/**
 * A declaration download: the parsed XML response plus the binary payload
 * carried in the multipart response's `application/octet-stream` part.
 */
export interface EvatDownload extends EvatResponse {
  /** The octet-stream part (e.g. the gzipped analytics), if present. */
  payload?: Uint8Array;
}

/**
 * POST an XML request to an operation whose response is `multipart/form-data`
 * (queryDeclarationData): the XML part is parsed, the octet-stream part is
 * returned as bytes. Parts are matched by content-type, since the spec does not
 * name the form fields.
 */
export async function postXmlForMultipart(
  baseUrl: string,
  operation: string,
  xml: string,
  options: EvatTransportOptions = {},
): Promise<EvatDownload> {
  const response = await rawPost(baseUrl, operation, options, {
    body: xml,
    headers: { 'content-type': 'application/xml', accept: 'multipart/form-data, application/xml' },
  });

  const contentType = response.headers.get('content-type') ?? '';
  const boundary = /boundary=("?)([^";]+)\1/i.exec(contentType)?.[2];
  if (!contentType.includes('multipart/') || !boundary) {
    // NAV may answer a not-found or an error as plain XML.
    const body = await response.text();
    return interpret(operation, response.status, body);
  }

  // Parse the multipart body from raw bytes rather than response.formData():
  // NAV's payload part carries no filename, so formData() would decode it as a
  // (UTF-8-mangled) string and corrupt the gzip. NAV names the parts `body`
  // (the XML response) and `file` (the octet-stream payload), confirmed live.
  const parts = parseMultipart(new Uint8Array(await response.arrayBuffer()), boundary);
  const xmlPart = parts.get('body') ?? firstXml(parts);
  const payload = parts.get('file') ?? firstBinary(parts);
  if (!xmlPart) {
    throw new NavTransportError(`eVAT ${operation} multipart response had no XML part`);
  }
  return {
    ...interpret(operation, response.status, new TextDecoder().decode(xmlPart)),
    ...(payload ? { payload } : {}),
  };
}

/** Split a multipart/form-data body into its parts, keeping binary bodies intact. */
function parseMultipart(buf: Uint8Array, boundary: string): Map<string, Uint8Array> {
  const text = latin1(buf);
  const delimiter = `--${boundary}`;
  const result = new Map<string, Uint8Array>();
  let index = text.indexOf(delimiter);
  while (index >= 0) {
    const start = index + delimiter.length;
    if (text.startsWith('--', start)) break; // closing boundary
    const headerEnd = text.indexOf('\r\n\r\n', start);
    if (headerEnd < 0) break;
    const headers = text.slice(start, headerEnd);
    const bodyStart = headerEnd + 4;
    const next = text.indexOf(delimiter, bodyStart);
    if (next < 0) break;
    // The body ends at the CRLF that precedes the next boundary.
    const body = buf.subarray(bodyStart, next - 2);
    const name = /name="([^"]*)"/i.exec(headers)?.[1];
    if (name) result.set(name, body);
    index = next;
  }
  return result;
}

function firstXml(parts: Map<string, Uint8Array>): Uint8Array | undefined {
  for (const bytes of parts.values()) if (looksXml(bytes)) return bytes;
  return undefined;
}

function firstBinary(parts: Map<string, Uint8Array>): Uint8Array | undefined {
  for (const bytes of parts.values()) if (!looksXml(bytes)) return bytes;
  return undefined;
}

function looksXml(bytes: Uint8Array): boolean {
  // Skip a UTF-8 BOM, then expect '<'.
  let i = 0;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) i = 3;
  return bytes[i] === 0x3c; // '<'
}

function latin1(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return s;
}

/**
 * Decode an {@link EvatDownload} payload to text. NAV gzips the octet-stream
 * part of a data download (magic `1f 8b`, confirmed live), so this gunzips when
 * it sees the gzip header and otherwise returns the bytes as UTF-8.
 */
export function decodeDownloadPayload(payload: Uint8Array): string {
  if (payload[0] === 0x1f && payload[1] === 0x8b) {
    return gunzipSync(Buffer.from(payload)).toString('utf8');
  }
  return new TextDecoder().decode(payload);
}

async function send(
  baseUrl: string,
  operation: string,
  options: EvatTransportOptions,
  request: { body: string | FormData; headers: Record<string, string> },
): Promise<EvatResponse> {
  const response = await rawPost(baseUrl, operation, options, request);
  const body = await response.text();
  return interpret(operation, response.status, body);
}

async function rawPost(
  baseUrl: string,
  operation: string,
  options: EvatTransportOptions,
  request: { body: string | FormData; headers: Record<string, string> },
): Promise<Response> {
  const doFetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let base = baseUrl;
  while (base.endsWith('/')) base = base.slice(0, -1);
  const url = `${base}/${operation}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await doFetch(url, {
      method: 'POST',
      headers: { ...request.headers, ...options.headers },
      body: request.body,
      signal: controller.signal,
    });
  } catch (cause) {
    throw new NavTransportError(`eVAT ${operation} request failed: ${(cause as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Parse the response body and turn a NAV error verdict into an exception. */
function interpret(operation: string, status: number, body: string): EvatResponse {
  let root: string;
  let value: unknown;
  try {
    const parsed = parseDocument(body, { unknownElements: 'ignore' });
    root = parsed.root;
    value = parsed.value;
  } catch (cause) {
    if (status >= 200 && status < 300) {
      throw new NavTransportError(
        `eVAT ${operation} returned an unparseable response: ${(cause as Error).message}`,
      );
    }
    throw new NavApiError({
      message: `eVAT ${operation} failed with HTTP ${status}`,
      status,
      responseBody: body,
    });
  }

  const result = (value as { result?: { funcCode?: string; errorCode?: string; message?: string } })
    .result;
  if (result?.funcCode === 'ERROR' || status >= 300) {
    throw new NavApiError({
      message: result?.message ?? `eVAT ${operation} failed with HTTP ${status}`,
      status,
      funcCode: result?.funcCode,
      errorCode: result?.errorCode,
      responseBody: body,
    });
  }

  return { root, value, status, body };
}
