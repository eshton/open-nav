import { request as httpsRequest } from 'node:https';
import {
  DEFAULT_TIMEOUT_MS,
  fetchWithTimeout,
  interpretNavResponse,
  NavApiError,
  NavTransportError,
  type NavHttpResponse,
} from '@open-nav/core';
import { parseDocument } from './codec.js';

export interface ReceiptTransportOptions {
  /** Injectable for testing and custom runtimes. */
  fetch?: typeof globalThis.fetch;
  /** Per-request timeout in milliseconds. Defaults to 60 000. */
  timeoutMs?: number;
  /** Extra headers. */
  headers?: Record<string, string>;
}

/** A client certificate (PEM) for mutual-TLS authentication. */
export interface ClientCertificate {
  /** The authentication certificate, PEM. */
  cert: string;
  /** Its private key, PEM. */
  key: string;
  /** Optional CA chain to trust, PEM. */
  ca?: string | string[];
}

export interface SecureTransportOptions extends ReceiptTransportOptions {
  /**
   * Authentication certificate for mutual TLS. Required for the authenticated
   * data services unless a custom {@link ReceiptTransportOptions.fetch} already
   * presents one.
   */
  clientCertificate?: ClientCertificate;
}

/** A parsed eNyugta response (the shared NAV response shape). */
export type ReceiptResponse = NavHttpResponse;

const XML_HEADERS = { 'content-type': 'application/xml', accept: 'application/xml' };
const LABEL = 'eNyugta request';

const parse = (body: string): { root: string; value: unknown } =>
  parseDocument(body, { unknownElements: 'ignore' });

/**
 * POST an eNyugta XML request to a full endpoint URL and parse the response.
 *
 * Used for the unauthenticated bootstrap services (device registration,
 * certificate renewal); the authenticated data services add a client
 * certificate — see {@link postReceiptXmlSecure}.
 */
export async function postReceiptXml(
  url: string,
  xml: string,
  options: ReceiptTransportOptions = {},
): Promise<ReceiptResponse> {
  const response = await fetchWithTimeout(
    url,
    { method: 'POST', headers: { ...XML_HEADERS, ...options.headers }, body: xml },
    { fetch: options.fetch, timeoutMs: options.timeoutMs, label: LABEL },
  );
  return interpretNavResponse(await response.text(), response.status, { label: LABEL, parse });
}

/**
 * POST an eNyugta XML request over a mutual-TLS connection authenticated with
 * the register's authentication certificate — the authenticated data services
 * (document/report submission, Hello, CashRegisterInfo).
 *
 * When a custom `fetch` is supplied (e.g. a test stub or a runtime that manages
 * the client certificate itself) it is used as-is; otherwise the request goes
 * out via Node's TLS stack presenting `clientCertificate`.
 */
export async function postReceiptXmlSecure(
  url: string,
  xml: string,
  options: SecureTransportOptions = {},
): Promise<ReceiptResponse> {
  if (options.fetch) return postReceiptXml(url, xml, options);
  if (!options.clientCertificate) {
    throw new NavTransportError(
      'a client certificate is required for the authenticated eNyugta services',
    );
  }
  const { body, status } = await postWithClientCertificate(url, xml, options);
  return interpretNavResponse(body, status, { label: LABEL, parse });
}

/** Low-level mutual-TLS POST via Node's `https` (client certificate presented). */
function postWithClientCertificate(
  url: string,
  xml: string,
  options: SecureTransportOptions,
): Promise<{ body: string; status: number }> {
  const cert = options.clientCertificate!;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      url,
      {
        method: 'POST',
        headers: {
          ...XML_HEADERS,
          'content-length': Buffer.byteLength(xml).toString(),
          ...options.headers,
        },
        cert: cert.cert,
        key: cert.key,
        ...(cert.ca ? { ca: cert.ca } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({ body: Buffer.concat(chunks).toString('utf8'), status: res.statusCode ?? 0 }),
        );
        // Without this, a connection reset after the headers never settles the
        // promise (neither `end` nor the request-level `error` fires).
        res.on('error', (cause) =>
          reject(new NavTransportError(`eNyugta response failed: ${cause.message}`)),
        );
      },
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new NavTransportError(`eNyugta request timed out after ${timeoutMs}ms`));
    });
    req.on('error', (cause) =>
      reject(new NavTransportError(`eNyugta request failed: ${cause.message}`)),
    );
    req.end(xml);
  });
}

/**
 * Download a NAV-issued certificate from the endpoint URL the registration or
 * renewal response returns. The spec asks the register to wait 5 seconds before
 * the first attempt; `waitMs` (default 5000) does that.
 */
export async function downloadCertificate(
  url: string,
  options: ReceiptTransportOptions & { waitMs?: number } = {},
): Promise<string> {
  const doFetch = options.fetch ?? globalThis.fetch;
  const waitMs = options.waitMs ?? 5000;
  if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));

  const response = await doFetch(url, { method: 'GET', headers: options.headers ?? {} });
  if (!response.ok) {
    throw new NavApiError({
      message: `certificate not available yet (HTTP ${response.status})`,
      status: response.status,
    });
  }
  return response.text();
}
