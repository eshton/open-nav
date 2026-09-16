import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { NavApiError, NavTransportError } from '../src/errors.js';
import {
  fetchTextWithTimeout,
  fetchWithTimeout,
  firstBinaryPart,
  firstXmlPart,
  interpretNavResponse,
  parseMultipart,
  trimTrailingSlash,
} from '../src/net/transport.js';

const parse = (body: string): { root: string; value: unknown } => ({
  root: 'R',
  value: JSON.parse(body),
});

describe('interpretNavResponse', () => {
  it('returns the parsed value on a normal response', () => {
    const r = interpretNavResponse('{"result":{"funcCode":"OK"}}', 200, { label: 'x', parse });
    expect(r.root).toBe('R');
    expect((r.value as { result: { funcCode: string } }).result.funcCode).toBe('OK');
  });

  it('throws NavApiError with the fault code on an ERROR verdict', () => {
    try {
      interpretNavResponse('{"result":{"funcCode":"ERROR","errorCode":"FORBIDDEN"}}', 200, {
        label: 'x',
        parse,
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(NavApiError);
      expect((error as NavApiError).errorCode).toBe('FORBIDDEN');
    }
  });

  it('throws NavApiError on HTTP >= 300', () => {
    expect(() => interpretNavResponse('{}', 500, { label: 'x', parse })).toThrow(NavApiError);
  });

  it('throws NavTransportError when a 2xx body will not parse', () => {
    expect(() => interpretNavResponse('not json', 200, { label: 'x', parse })).toThrow(
      NavTransportError,
    );
  });

  it('does not throw a raw TypeError on a non-object parsed value', () => {
    const r = interpretNavResponse('42', 200, { label: 'x', parse });
    expect(r.value).toBe(42);
  });
});

describe('fetchWithTimeout', () => {
  it('reports a timeout distinctly', async () => {
    const hang: typeof globalThis.fetch = ((_url, init) =>
      new Promise((_resolve, reject) => {
        (init?.signal as AbortSignal).addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      })) as unknown as typeof globalThis.fetch;
    await expect(
      fetchWithTimeout('https://x', { method: 'GET' }, { fetch: hang, timeoutMs: 10, label: 'op' }),
    ).rejects.toThrow(/timed out after 10ms/);
  });
});

describe('trimTrailingSlash', () => {
  it('strips trailing slashes', () => {
    expect(trimTrailingSlash('https://x/v1/')).toBe('https://x/v1');
    expect(trimTrailingSlash('https://x/v1///')).toBe('https://x/v1');
    expect(trimTrailingSlash('https://x/v1')).toBe('https://x/v1');
  });
});

describe('parseMultipart', () => {
  it('keeps a no-filename binary part intact (the gzip-corruption bug)', () => {
    const boundary = 'abc123';
    const gz = gzipSync(Buffer.from('<VatDeclarationData/>', 'utf8'));
    const enc = new TextEncoder();
    const chunks: Uint8Array[] = [
      enc.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="body"\r\nContent-Type: application/xml\r\n\r\n`,
      ),
      enc.encode('<ok/>'),
      enc.encode(
        `\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      new Uint8Array(gz),
      enc.encode(`\r\n--${boundary}--\r\n`),
    ];
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const body = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      body.set(c, offset);
      offset += c.length;
    }

    const parts = parseMultipart(body, boundary);
    expect(new TextDecoder().decode(firstXmlPart(parts)!)).toBe('<ok/>');
    // The binary part must be byte-identical to the original gzip.
    expect(new Uint8Array(firstBinaryPart(parts)!)).toEqual(new Uint8Array(gz));
    expect(parts.get('file')).toEqual(new Uint8Array(gz));
  });
});

describe('fetchTextWithTimeout', () => {
  it('times out when the peer sends headers and then stalls mid-body', async () => {
    // The bug this covers: timing only the `fetch` call disarms the timer the
    // moment the headers arrive, so a body that never finishes hangs forever
    // and `timeoutMs` means nothing. The deadline has to span the body read.
    const stalling: typeof globalThis.fetch = (async (_url, init) =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('<partial'));
            // ... and never closes.
            (init?.signal as AbortSignal).addEventListener('abort', () => {
              controller.error(new Error('aborted'));
            });
          },
        }),
        { status: 200 },
      )) as unknown as typeof globalThis.fetch;

    await expect(
      fetchTextWithTimeout(
        'https://x',
        { method: 'POST' },
        { fetch: stalling, timeoutMs: 20, label: 'op' },
      ),
    ).rejects.toThrow(/timed out after 20ms/);
  });

  it('reads a normal body under the deadline', async () => {
    const ok: typeof globalThis.fetch = (async () =>
      new Response('<Ok/>', { status: 200 })) as unknown as typeof globalThis.fetch;
    const response = await fetchTextWithTimeout(
      'https://x',
      { method: 'POST' },
      { fetch: ok, timeoutMs: 1000, label: 'op' },
    );
    expect(response.body).toBe('<Ok/>');
    expect(response.status).toBe(200);
  });

  it('refuses a body past the size cap instead of buffering it', async () => {
    const chunk = new Uint8Array(1024 * 1024);
    const endless: typeof globalThis.fetch = (async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(chunk);
          },
        }),
        { status: 200 },
      )) as unknown as typeof globalThis.fetch;

    await expect(
      fetchTextWithTimeout(
        'https://x',
        { method: 'POST' },
        { fetch: endless, timeoutMs: 30_000, label: 'op' },
      ),
    ).rejects.toThrow(/exceeded the \d+ byte limit/);
  });
});
