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
 * The interface spec states the request is `application/xml` and the payload
 * `application/octet-stream` but does not print the form-field names. These are
 * a best-effort default and are configurable via {@link EvatTransportOptions}
 * so a live run (EVAT-10) can pin them without a code change.
 */
export const MULTIPART_FIELDS = { request: 'request', file: 'file' } as const;

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
  if (!contentType.includes('multipart/')) {
    // NAV may answer a not-found or an error as plain XML.
    const body = await response.text();
    return interpret(operation, response.status, body);
  }

  const form = await response.formData();
  let xmlPart: string | undefined;
  let payload: Uint8Array | undefined;
  for (const value of form.values()) {
    if (typeof value === 'string') {
      xmlPart ??= value;
      continue;
    }
    const bytes = new Uint8Array(await value.arrayBuffer());
    if (value.type.includes('xml')) xmlPart ??= new TextDecoder().decode(bytes);
    else payload ??= bytes;
  }
  if (!xmlPart) {
    throw new NavTransportError(`eVAT ${operation} multipart response had no XML part`);
  }
  return { ...interpret(operation, response.status, xmlPart), ...(payload ? { payload } : {}) };
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
