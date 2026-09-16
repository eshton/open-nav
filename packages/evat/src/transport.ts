import { gunzipSync } from 'node:zlib';
import {
  fetchBytesWithTimeout,
  fetchTextWithTimeout,
  firstBinaryPart,
  firstXmlPart,
  interpretNavResponse,
  MAX_DECOMPRESSED_BYTES,
  NavTransportError,
  parseMultipart,
  trimTrailingSlash,
  type NavHttpResponse,
} from '@open-nav/core';
import { parseDocument } from './codec.js';

export interface EvatTransportOptions {
  /** Injectable for testing and for runtimes with a custom fetch. */
  fetch?: typeof globalThis.fetch;
  /** Per-request timeout in milliseconds. Defaults to 60 000. */
  timeoutMs?: number;
  /** Extra headers, e.g. a correlation id for your own logs. */
  headers?: Record<string, string>;
}

/** A parsed eVAT response (the shared NAV response shape). */
export type EvatResponse = NavHttpResponse;

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
 * via the `fields` argument should NAV ever change it.
 */
export const MULTIPART_FIELDS = { request: 'body', file: 'file' } as const;

const parse = (body: string): { root: string; value: unknown } =>
  parseDocument(body, { unknownElements: 'ignore' });

const endpoint = (baseUrl: string, operation: string): string =>
  `${trimTrailingSlash(baseUrl)}/${operation}`;

/** POST an XML request to an eVAT operation and parse the response. */
export async function postXml(
  baseUrl: string,
  operation: string,
  xml: string,
  options: EvatTransportOptions = {},
): Promise<EvatResponse> {
  const label = `eVAT ${operation}`;
  const response = await fetchTextWithTimeout(
    endpoint(baseUrl, operation),
    {
      method: 'POST',
      headers: { 'content-type': 'application/xml', accept: 'application/xml', ...options.headers },
      body: xml,
    },
    { fetch: options.fetch, timeoutMs: options.timeoutMs, label },
  );
  return interpretNavResponse(response.body, response.status, { label, parse });
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
  const label = `eVAT ${operation}`;
  const form = new FormData();
  form.append(fields.request, new Blob([xml], { type: 'application/xml' }));
  form.append(
    fields.file,
    new Blob([part.bytes], { type: 'application/octet-stream' }),
    part.fileName ?? 'partition.bin',
  );
  // Let fetch set the multipart content-type with its boundary.
  const response = await fetchTextWithTimeout(
    endpoint(baseUrl, operation),
    {
      method: 'POST',
      headers: { accept: 'multipart/form-data, application/xml', ...options.headers },
      body: form,
    },
    { fetch: options.fetch, timeoutMs: options.timeoutMs, label },
  );
  return interpretNavResponse(response.body, response.status, { label, parse });
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
 * (queryVatDeclarationData / queryDeclarationData): the `body` XML part is
 * parsed, the `file` octet-stream part is returned as bytes. NAV may also answer
 * a not-found or error as plain XML, which is parsed as usual.
 */
export async function postXmlForMultipart(
  baseUrl: string,
  operation: string,
  xml: string,
  options: EvatTransportOptions = {},
): Promise<EvatDownload> {
  const label = `eVAT ${operation}`;
  const response = await fetchBytesWithTimeout(
    endpoint(baseUrl, operation),
    {
      method: 'POST',
      headers: {
        'content-type': 'application/xml',
        accept: 'multipart/form-data, application/xml',
        ...options.headers,
      },
      body: xml,
    },
    { fetch: options.fetch, timeoutMs: options.timeoutMs, label },
  );

  const contentType = response.headers.get('content-type') ?? '';
  const boundary = /boundary=("?)([^";]+)\1/i.exec(contentType)?.[2];
  if (!contentType.includes('multipart/') || !boundary) {
    return interpretNavResponse(new TextDecoder().decode(response.body), response.status, {
      label,
      parse,
    });
  }

  const parts = parseMultipart(response.body, boundary);
  const xmlPart = parts.get('body') ?? firstXmlPart(parts);
  const payload = parts.get('file') ?? firstBinaryPart(parts);
  if (!xmlPart) {
    throw new NavTransportError(`${label} multipart response had no XML part`);
  }
  return {
    ...interpretNavResponse(new TextDecoder().decode(xmlPart), response.status, { label, parse }),
    ...(payload ? { payload } : {}),
  };
}

/**
 * Decode an {@link EvatDownload} payload to text. NAV gzips the octet-stream
 * part of a data download (magic `1f 8b`, confirmed live), so this gunzips when
 * it sees the gzip header and otherwise returns the bytes as UTF-8.
 */
export function decodeDownloadPayload(payload: Uint8Array): string {
  if (payload[0] === 0x1f && payload[1] === 0x8b) {
    // Capped: a few hundred kilobytes of gzip expands to hundreds of megabytes,
    // and this payload comes off the wire. Past the cap gunzipSync throws.
    return gunzipSync(Buffer.from(payload), {
      maxOutputLength: MAX_DECOMPRESSED_BYTES,
    }).toString('utf8');
  }
  return new TextDecoder().decode(payload);
}
