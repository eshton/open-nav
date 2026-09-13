import { request as httpsRequest } from 'node:https';
import { NavApiError, NavTransportError } from '@open-nav/core';
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

export interface ReceiptResponse {
  root: string;
  value: unknown;
  status: number;
  body: string;
}

const DEFAULT_TIMEOUT_MS = 60_000;

const XML_HEADERS = { 'content-type': 'application/xml', accept: 'application/xml' };

/** Parse a response body, raising NavApiError on an ERROR verdict or HTTP >= 300. */
function interpret(body: string, status: number): ReceiptResponse {
  let root: string;
  let value: unknown;
  try {
    const parsed = parseDocument(body, { unknownElements: 'ignore' });
    root = parsed.root;
    value = parsed.value;
  } catch (cause) {
    if (status >= 200 && status < 300) {
      throw new NavTransportError(
        `eNyugta response was not parseable: ${(cause as Error).message}`,
      );
    }
    throw new NavApiError({ message: `eNyugta request failed`, status, responseBody: body });
  }

  const result = (value as { result?: { funcCode?: string; errorCode?: string; message?: string } })
    .result;
  if (result?.funcCode === 'ERROR' || status >= 300) {
    throw new NavApiError({
      message: result?.message ?? `eNyugta request failed with HTTP ${status}`,
      status,
      funcCode: result?.funcCode,
      errorCode: result?.errorCode,
      responseBody: body,
    });
  }

  return { root, value, status, body };
}

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
  const doFetch = options.fetch ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let response: Response;
  try {
    response = await doFetch(url, {
      method: 'POST',
      headers: { ...XML_HEADERS, ...options.headers },
      body: xml,
      signal: controller.signal,
    });
  } catch (cause) {
    throw new NavTransportError(`eNyugta request failed: ${(cause as Error).message}`);
  } finally {
    clearTimeout(timer);
  }

  return interpret(await response.text(), response.status);
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
  return interpret(body, status);
}

/** Low-level mutual-TLS POST via Node's `https` (client certificate presented). */
function postWithClientCertificate(
  url: string,
  xml: string,
  options: SecureTransportOptions,
): Promise<{ body: string; status: number }> {
  const cert = options.clientCertificate!;
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
      },
    );
    req.setTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, () => {
      req.destroy(
        new Error(`request timed out after ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`),
      );
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
