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

export interface ReceiptResponse {
  root: string;
  value: unknown;
  status: number;
  body: string;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * POST an eNyugta XML request to a full endpoint URL and parse the response.
 *
 * Used for the unauthenticated bootstrap services (device registration,
 * certificate renewal); the authenticated data services add a client
 * certificate (mutual TLS) — a later step (ONAV-41).
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
      headers: { 'content-type': 'application/xml', accept: 'application/xml', ...options.headers },
      body: xml,
      signal: controller.signal,
    });
  } catch (cause) {
    throw new NavTransportError(`eNyugta request failed: ${(cause as Error).message}`);
  } finally {
    clearTimeout(timer);
  }

  const body = await response.text();
  let root: string;
  let value: unknown;
  try {
    const parsed = parseDocument(body, { unknownElements: 'ignore' });
    root = parsed.root;
    value = parsed.value;
  } catch (cause) {
    if (response.status >= 200 && response.status < 300) {
      throw new NavTransportError(
        `eNyugta response was not parseable: ${(cause as Error).message}`,
      );
    }
    throw new NavApiError({
      message: `eNyugta request failed`,
      status: response.status,
      responseBody: body,
    });
  }

  const result = (value as { result?: { funcCode?: string; errorCode?: string; message?: string } })
    .result;
  if (result?.funcCode === 'ERROR' || response.status >= 300) {
    throw new NavApiError({
      message: result?.message ?? `eNyugta request failed with HTTP ${response.status}`,
      status: response.status,
      funcCode: result?.funcCode,
      errorCode: result?.errorCode,
      responseBody: body,
    });
  }

  return { root, value, status: response.status, body };
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
