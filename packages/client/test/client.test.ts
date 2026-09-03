import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NavApiError,
  NavValidationError,
  decodeInvoiceData,
  operationHash,
  parseDocument,
  passwordHash,
  requestSignature,
  type InvoiceData,
} from '@open-nav/core';
import { describe, expect, it } from 'vitest';
import { NavClient } from '../src/client.js';
import {
  CREDENTIALS,
  EXCHANGE_TOKEN,
  SOFTWARE,
  generalErrorResponse,
  manageInvoiceResponse,
  stubFetch,
  tokenExchangeResponse,
} from './support.js';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, '..', '..', '..');

/** A real NAV sample invoice, so the payload under test is genuine. */
function sampleInvoice(): InvoiceData {
  const xml = readFileSync(
    join(REPO_ROOT, 'conformance', 'data-samples', 'belfoldi-termekertekesites.xml'),
    'utf8',
  );
  return parseDocument(xml).value as InvoiceData;
}

function client(fetchStub: typeof globalThis.fetch, retries = 0) {
  return new NavClient({
    credentials: CREDENTIALS,
    software: SOFTWARE,
    baseUrl: 'https://nav.example.invalid/invoiceService/v1',
    now: () => new Date('2026-03-01T09:59:00.000Z'),
    transport: { fetch: fetchStub, retries },
  });
}

describe('credentials', () => {
  it('rejects an 11 digit tax number, the most common mistake', () => {
    expect(
      () =>
        new NavClient({
          credentials: { ...CREDENTIALS, taxNumber: '11111111242' },
          software: SOFTWARE,
        }),
    ).toThrowError(/8 digit core tax number/);
  });

  it('rejects an exchange key that is not 16 characters', () => {
    expect(
      () =>
        new NavClient({ credentials: { ...CREDENTIALS, exchangeKey: 'nope' }, software: SOFTWARE }),
    ).toThrowError(NavValidationError);
  });
});

describe('tokenExchange', () => {
  it('decrypts the exchange token', async () => {
    const { fetch, requests } = stubFetch(() => ({ body: tokenExchangeResponse() }));
    const result = await client(fetch).tokenExchange();

    expect(result.token).toBe(EXCHANGE_TOKEN);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe('https://nav.example.invalid/invoiceService/v1/tokenExchange');
  });

  it('signs the request the way NAV will verify it', async () => {
    const { fetch, requests } = stubFetch(() => ({ body: tokenExchangeResponse() }));
    await client(fetch).tokenExchange();

    const sent = parseDocument(requests[0]!.body).value as {
      header: { requestId: string; timestamp: string; requestVersion: string };
      user: {
        login: string;
        passwordHash: { value: string; cryptoType: string };
        requestSignature: { value: string; cryptoType: string };
        taxNumber: string;
      };
    };

    expect(sent.header.requestVersion).toBe('3.0');
    expect(sent.user.login).toBe(CREDENTIALS.login);
    expect(sent.user.taxNumber).toBe(CREDENTIALS.taxNumber);
    expect(sent.user.passwordHash).toEqual({
      value: passwordHash(CREDENTIALS.password),
      cryptoType: 'SHA-512',
    });
    expect(sent.user.requestSignature).toEqual({
      value: requestSignature(sent.header.requestId, sent.header.timestamp, CREDENTIALS.signKey),
      cryptoType: 'SHA3-512',
    });
  });

  it('never puts the password or keys on the wire', async () => {
    const { fetch, requests } = stubFetch(() => ({ body: tokenExchangeResponse() }));
    await client(fetch).tokenExchange();

    expect(requests[0]!.body).not.toContain(CREDENTIALS.password);
    expect(requests[0]!.body).not.toContain(CREDENTIALS.signKey);
    expect(requests[0]!.body).not.toContain(CREDENTIALS.exchangeKey);
  });
});

describe('submitInvoices', () => {
  const route = (call: number) =>
    call === 0 ? { body: tokenExchangeResponse() } : { body: manageInvoiceResponse('TX42') };

  it('exchanges a token, then submits the batch', async () => {
    const { fetch, requests } = stubFetch((_url, _body, call) => route(call));
    const response = await client(fetch).submitInvoices([
      { operation: 'CREATE', invoice: sampleInvoice() },
    ]);

    expect(response.transactionId).toBe('TX42');
    expect(requests.map((request) => request.url.split('/').pop())).toEqual([
      'tokenExchange',
      'manageInvoice',
    ]);
  });

  it('signs the batch over the payloads it actually sends', async () => {
    const { fetch, requests } = stubFetch((_url, _body, call) => route(call));
    await client(fetch).submitInvoices([
      { operation: 'CREATE', invoice: sampleInvoice() },
      { operation: 'STORNO', invoice: sampleInvoice() },
    ]);

    const sent = parseDocument(requests[1]!.body).value as {
      header: { requestId: string; timestamp: string };
      user: { requestSignature: { value: string } };
      exchangeToken: string;
      invoiceOperations: {
        compressedContent: boolean;
        invoiceOperation: Array<{ index: number; invoiceOperation: string; invoiceData: string }>;
      };
    };

    expect(sent.exchangeToken).toBe(EXCHANGE_TOKEN);
    expect(sent.invoiceOperations.invoiceOperation.map((op) => op.index)).toEqual([1, 2]);
    expect(sent.invoiceOperations.invoiceOperation.map((op) => op.invoiceOperation)).toEqual([
      'CREATE',
      'STORNO',
    ]);

    // Recompute the signature the way NAV does, from the payloads on the wire.
    const expected = requestSignature(
      sent.header.requestId,
      sent.header.timestamp,
      CREDENTIALS.signKey,
      sent.invoiceOperations.invoiceOperation.map((op) => ({
        index: op.index,
        operation: op.invoiceOperation,
        base64Payload: op.invoiceData,
      })),
    );
    expect(sent.user.requestSignature.value).toBe(expected);

    // The same invoice submitted under two operations yields identical
    // payloads but distinct hashes, because the operation is part of the hash.
    const [first, second] = sent.invoiceOperations.invoiceOperation;
    expect(first!.invoiceData).toBe(second!.invoiceData);
    expect(operationHash('CREATE', first!.invoiceData)).not.toBe(
      operationHash('STORNO', second!.invoiceData),
    );
  });

  it('round trips the invoice through base64 unchanged', async () => {
    const invoice = sampleInvoice();
    const { fetch, requests } = stubFetch((_url, _body, call) => route(call));
    await client(fetch).submitInvoices([{ operation: 'CREATE', invoice }]);

    const sent = parseDocument(requests[1]!.body).value as {
      invoiceOperations: { invoiceOperation: Array<{ invoiceData: string }> };
    };
    expect(decodeInvoiceData(sent.invoiceOperations.invoiceOperation[0]!.invoiceData)).toEqual(
      invoice,
    );
  });

  it('compresses when asked, and the payload still decodes', async () => {
    const invoice = sampleInvoice();
    const { fetch, requests } = stubFetch((_url, _body, call) => route(call));
    await client(fetch).submitInvoices([{ operation: 'CREATE', invoice }], { compress: true });

    const sent = parseDocument(requests[1]!.body).value as {
      invoiceOperations: {
        compressedContent: boolean;
        invoiceOperation: Array<{ invoiceData: string }>;
      };
    };
    expect(sent.invoiceOperations.compressedContent).toBe(true);
    const payload = sent.invoiceOperations.invoiceOperation[0]!.invoiceData;
    expect(Buffer.from(payload, 'base64')[0]).toBe(0x1f); // gzip magic
    expect(decodeInvoiceData(payload)).toEqual(invoice);
  });

  it('refuses an empty batch and an oversized one', async () => {
    const { fetch } = stubFetch(() => ({ body: tokenExchangeResponse() }));
    const navClient = client(fetch);
    await expect(navClient.submitInvoices([])).rejects.toThrowError(/at least one/);
    await expect(
      navClient.submitInvoices(
        Array.from({ length: 101 }, () => ({
          operation: 'CREATE' as const,
          invoice: sampleInvoice(),
        })),
      ),
    ).rejects.toThrowError(/at most 100/);
  });
});

describe('error handling', () => {
  it('maps a GeneralErrorResponse to a typed error', async () => {
    const { fetch } = stubFetch(() => ({
      status: 400,
      body: generalErrorResponse('INVALID_SECURITY_USER', 'Technical user not found'),
    }));

    const error = await client(fetch)
      .tokenExchange()
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(NavApiError);
    const apiError = error as NavApiError;
    expect(apiError.errorCode).toBe('INVALID_SECURITY_USER');
    expect(apiError.funcCode).toBe('ERROR');
    expect(apiError.status).toBe(400);
    expect(apiError.validationMessages[0]?.validationErrorCode).toBe('INVALID_SECURITY_USER');
    expect(apiError.message).toContain('Technical user not found');
  });

  it('surfaces an unparseable body rather than throwing something obscure', async () => {
    const { fetch } = stubFetch(() => ({ status: 502, body: '<html>gateway</html>' }));
    const error = (await client(fetch)
      .tokenExchange()
      .catch((caught: unknown) => caught)) as NavApiError;

    expect(error).toBeInstanceOf(NavApiError);
    expect(error.status).toBe(502);
    expect(error.responseBody).toContain('gateway');
  });

  it('does not retry a 4xx', async () => {
    const { fetch, requests } = stubFetch(() => ({
      status: 400,
      body: generalErrorResponse('INVALID_REQUEST', 'nope'),
    }));
    await expect(client(fetch, 3).tokenExchange()).rejects.toThrowError(NavApiError);
    expect(requests).toHaveLength(1);
  });

  it('retries a 5xx and succeeds', async () => {
    const { fetch, requests } = stubFetch((_url, _body, call) =>
      call === 0 ? { status: 503, body: '<html>busy</html>' } : { body: tokenExchangeResponse() },
    );
    const result = await client(fetch, 1).tokenExchange();
    expect(result.token).toBe(EXCHANGE_TOKEN);
    expect(requests).toHaveLength(2);
  });

  it('never retries a submission, even on 5xx', async () => {
    // A manageInvoice that reached NAV must not be resent: the requestId
    // would be a replay, and a delivered batch could be duplicated.
    const { fetch, requests } = stubFetch((url, _body, call) =>
      url.endsWith('tokenExchange') && call === 0
        ? { body: tokenExchangeResponse() }
        : { status: 503, body: '<html>busy</html>' },
    );
    await expect(
      client(fetch, 3).submitInvoices([{ operation: 'CREATE', invoice: sampleInvoice() }]),
    ).rejects.toThrowError();
    expect(requests.filter((request) => request.url.endsWith('manageInvoice'))).toHaveLength(1);
  });
});
