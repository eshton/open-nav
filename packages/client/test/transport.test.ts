import { describe, expect, it } from 'vitest';
import { NavApiError } from '@open-nav/core';
import { parseRetryAfter, postXml } from '../src/transport.js';
import { tokenExchangeResponse } from './support.js';

/** A fetch that plays a scripted list of responses, one per call. */
function scriptedFetch(replies: Response[]): {
  fetch: typeof globalThis.fetch;
  calls: () => number;
} {
  let call = 0;
  const fetchStub = (async () => {
    const reply = replies[Math.min(call, replies.length - 1)]!;
    call += 1;
    return reply.clone();
  }) as unknown as typeof globalThis.fetch;
  return { fetch: fetchStub, calls: () => call };
}

const xml = (body: string, init: ResponseInit): Response =>
  new Response(body, { headers: { 'content-type': 'application/xml' }, ...init });

describe('parseRetryAfter', () => {
  it('reads a delay in seconds', () => {
    expect(parseRetryAfter('5')).toBe(5000);
    expect(parseRetryAfter('0')).toBe(0);
  });

  it('reads an HTTP date relative to now', () => {
    const now = Date.parse('2026-03-01T10:00:00.000Z');
    expect(parseRetryAfter('Sun, 01 Mar 2026 10:00:10 GMT', now)).toBe(10_000);
  });

  it('clamps a past date to zero', () => {
    const now = Date.parse('2026-03-01T10:00:00.000Z');
    expect(parseRetryAfter('Sun, 01 Mar 2026 09:59:50 GMT', now)).toBe(0);
  });

  it('caps an unreasonably long wait at one minute', () => {
    expect(parseRetryAfter('100000')).toBe(60_000);
  });

  it('ignores an absent or unparseable value', () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('')).toBeUndefined();
    expect(parseRetryAfter('soon')).toBeUndefined();
  });
});

describe('postXml retrying', () => {
  it('retries a 429 with Retry-After, then succeeds', async () => {
    const { fetch, calls } = scriptedFetch([
      xml('<busy/>', {
        status: 429,
        headers: { 'retry-after': '0', 'content-type': 'text/plain' },
      }),
      xml(tokenExchangeResponse(), { status: 200 }),
    ]);
    const response = await postXml('http://nav.test/v1', 'tokenExchange', '<req/>', {
      fetch,
      retries: 2,
    });
    expect(calls()).toBe(2);
    expect(response.root).toBe('TokenExchangeResponse');
  });

  it('retries a 503, then succeeds', async () => {
    const { fetch, calls } = scriptedFetch([
      xml('<busy/>', { status: 503 }),
      xml(tokenExchangeResponse(), { status: 200 }),
    ]);
    const response = await postXml('http://nav.test/v1', 'tokenExchange', '<req/>', {
      fetch,
      retries: 2,
    });
    expect(calls()).toBe(2);
    expect(response.root).toBe('TokenExchangeResponse');
  });

  it('gives up and throws once the throttle outlasts the retries', async () => {
    const { fetch, calls } = scriptedFetch([
      xml('<busy/>', { status: 429, headers: { 'retry-after': '0' } }),
    ]);
    await expect(
      postXml('http://nav.test/v1', 'tokenExchange', '<req/>', { fetch, retries: 1 }),
    ).rejects.toBeInstanceOf(NavApiError);
    // One initial attempt plus one retry.
    expect(calls()).toBe(2);
  });

  it('does not retry when the call is marked non-retryable', async () => {
    const { fetch, calls } = scriptedFetch([xml('<busy/>', { status: 503 })]);
    await expect(
      postXml('http://nav.test/v1', 'manageInvoice', '<req/>', { fetch, retries: 3 }, false),
    ).rejects.toBeInstanceOf(NavApiError);
    expect(calls()).toBe(1);
  });
});
