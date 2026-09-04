import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NavApiError,
  decodeInvoiceData,
  parseDocument,
  type InvoiceData,
  type SoftwareType,
} from '@open-nav/core';
import { NavClient, waitForTransaction, type NavCredentials } from '@open-nav/client';
import { afterEach, describe, expect, it } from 'vitest';
import { startMockServer, type MockServer } from '../src/server.js';

/**
 * The whole stack, end to end.
 *
 * The real client talks to the mock over real HTTP, so this exercises
 * signature construction, XML serialisation, transport, response parsing and
 * the polling loop together. The mock verifies the signature the way NAV
 * does, which means a passing test here is meaningful evidence that the
 * request NAV receives would be accepted.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function sampleInvoice(name = 'belfoldi-termekertekesites.xml'): InvoiceData {
  const xml = readFileSync(join(REPO_ROOT, 'conformance', 'data-samples', name), 'utf8');
  return structuredClone(parseDocument(xml).value as InvoiceData);
}

/** Matches the supplier in the sample invoice, so the supplier check passes. */
const CREDENTIALS: NavCredentials = {
  login: 'mocklogin123',
  password: 'mock-password',
  signKey: 'mock-sign-key-0123456789',
  exchangeKey: '0123456789abcdef',
  taxNumber: '99999999',
};

const SOFTWARE: SoftwareType = {
  softwareId: 'OPENNAVTEST000001',
  softwareName: 'open-nav end to end',
  softwareOperation: 'LOCAL_SOFTWARE',
  softwareMainVersion: '0.1.0',
  softwareDevName: 'open-nav',
  softwareDevContact: 'dev@example.invalid',
};

let running: MockServer | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

async function start(options: Partial<Parameters<typeof startMockServer>[0]> = {}) {
  running = await startMockServer({ credentials: CREDENTIALS, ...options });
  return running;
}

function clientFor(mock: MockServer, credentials: NavCredentials = CREDENTIALS): NavClient {
  return new NavClient({
    credentials,
    software: SOFTWARE,
    baseUrl: mock.url,
    transport: { retries: 0 },
  });
}

describe('authentication', () => {
  it('accepts a correctly signed request', async () => {
    const mock = await start();
    const result = await clientFor(mock).tokenExchange();
    expect(result.token).toHaveLength(16);
    expect(mock.state.requests.map((request) => request.operation)).toEqual(['tokenExchange']);
  });

  it('rejects a wrong signature key with INVALID_SIGNATURE', async () => {
    const mock = await start();
    const client = clientFor(mock, { ...CREDENTIALS, signKey: 'wrong-key' });
    const error = (await client.tokenExchange().catch((caught: unknown) => caught)) as NavApiError;
    expect(error).toBeInstanceOf(NavApiError);
    expect(error.errorCode).toBe('INVALID_SIGNATURE');
  });

  it('rejects a wrong password with INVALID_SECURITY_USER', async () => {
    const mock = await start();
    const client = clientFor(mock, { ...CREDENTIALS, password: 'not-it' });
    const error = (await client.tokenExchange().catch((caught: unknown) => caught)) as NavApiError;
    expect(error.errorCode).toBe('INVALID_SECURITY_USER');
  });

  it('rejects a taxpayer the technical user is not registered for', async () => {
    const mock = await start();
    const client = clientFor(mock, { ...CREDENTIALS, taxNumber: '11111111' });
    const error = (await client.tokenExchange().catch((caught: unknown) => caught)) as NavApiError;
    expect(error.errorCode).toBe('INVALID_SECURITY_USER');
  });

  it('rejects a replayed requestId', async () => {
    // The client never replays, so replay the raw body to prove the mock
    // catches it — this is the failure mode of a home-made requestId scheme.
    const mock = await start();
    await clientFor(mock).tokenExchange();
    const first = mock.state.requests[0]!.body;

    const response = await fetch(`${mock.url}/tokenExchange`, {
      method: 'POST',
      body: first,
      headers: { 'content-type': 'application/xml' },
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('INVALID_REQUEST_ID');
  });
});

describe('submitting invoices', () => {
  it('submits a valid invoice and reaches DONE', async () => {
    const mock = await start();
    const client = clientFor(mock);

    const response = await client.submitInvoices([
      { operation: 'CREATE', invoice: sampleInvoice() },
    ]);
    expect(response.transactionId).toMatch(/^MOCKTX/);

    const outcome = await waitForTransaction(client, response.transactionId, {
      sleep: async () => {},
    });
    expect(outcome.accepted).toHaveLength(1);
    expect(outcome.rejected).toEqual([]);
    expect(mock.state.invoices.size).toBe(1);
  });

  it('stores exactly the payload that was sent', async () => {
    const mock = await start();
    const invoice = sampleInvoice();
    await clientFor(mock).submitInvoices([{ operation: 'CREATE', invoice }]);

    const stored = mock.state.invoices.get(invoice.invoiceNumber)!;
    expect(stored.supplierTaxNumber).toBe('99999999');
    expect(decodeInvoiceData(stored.base64)).toEqual(invoice);
  });

  it('works with compressed payloads', async () => {
    const mock = await start();
    const invoice = sampleInvoice();
    await clientFor(mock).submitInvoices([{ operation: 'CREATE', invoice }], { compress: true });

    const stored = mock.state.invoices.get(invoice.invoiceNumber)!;
    expect(stored.compressed).toBe(true);
    expect(decodeInvoiceData(stored.base64)).toEqual(invoice);
  });

  it('signs a multi-invoice batch so the service accepts it', async () => {
    // The batch signature concatenates per-operation hashes in index order;
    // getting that wrong is the classic failure, and the mock checks it.
    const mock = await start();
    const first = sampleInvoice();
    const second = sampleInvoice();
    second.invoiceNumber = `${first.invoiceNumber}-B`;

    const response = await clientFor(mock).submitInvoices([
      { operation: 'CREATE', invoice: first },
      { operation: 'CREATE', invoice: second },
    ]);
    const outcome = await waitForTransaction(clientFor(mock), response.transactionId, {
      sleep: async () => {},
    });
    expect(outcome.accepted).toHaveLength(2);
  });

  it('aborts an invoice the validator rejects, with NAV’s fault code', async () => {
    const mock = await start();
    const broken = sampleInvoice();
    broken.invoiceMain.invoice!.invoiceSummary.summaryNormal!.invoiceNetAmount = '1.00';

    const response = await clientFor(mock).submitInvoices([
      { operation: 'CREATE', invoice: broken },
    ]);
    const outcome = await waitForTransaction(clientFor(mock), response.transactionId, {
      sleep: async () => {},
    });

    expect(outcome.rejected).toHaveLength(1);
    expect(outcome.accepted).toEqual([]);
    expect(outcome.rejected[0]?.businessValidationMessages?.[0]?.validationErrorCode).toBe(
      'INCORRECT_SUMMARY_CALCULATION_VAT_RATE_NET_AMOUNT_SUMMARY',
    );
    expect(mock.state.invoices.size).toBe(0);
  });

  it('rejects a submission for a different supplier', async () => {
    const mock = await start();
    const foreign = sampleInvoice();
    foreign.invoiceMain.invoice!.invoiceHead.supplierInfo.supplierTaxNumber.taxpayerId = '11111111';

    const response = await clientFor(mock).submitInvoices([
      { operation: 'CREATE', invoice: foreign },
    ]);
    const outcome = await waitForTransaction(clientFor(mock), response.transactionId, {
      sleep: async () => {},
    });
    expect(outcome.rejected[0]?.businessValidationMessages?.[0]?.validationErrorCode).toBe(
      'SUPPLIER_TAX_NUMBER_MISMATCH',
    );
  });

  it('spends an exchange token exactly once', async () => {
    const mock = await start();
    await clientFor(mock).submitInvoices([{ operation: 'CREATE', invoice: sampleInvoice() }]);
    const tokens = [...mock.state.tokens.values()];
    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.spent).toBe(true);
  });
});

describe('the asynchronous lifecycle', () => {
  it('drives the caller through RECEIVED and PROCESSING before settling', async () => {
    const mock = await start({ pollsBeforeDone: 2 });
    const client = clientFor(mock);
    const response = await client.submitInvoices([
      { operation: 'CREATE', invoice: sampleInvoice() },
    ]);

    const seen: string[] = [];
    const outcome = await waitForTransaction(client, response.transactionId, {
      sleep: async () => {},
      onPoll: (results) => seen.push(results[0]!.invoiceStatus),
    });

    expect(seen).toEqual(['RECEIVED', 'PROCESSING', 'DONE']);
    expect(outcome.accepted).toHaveLength(1);
  });

  it('reports an unknown transaction as having no results yet', async () => {
    const mock = await start();
    const response = await clientFor(mock).queryTransactionStatus({ transactionId: 'NOSUCHTX' });
    expect(response.processingResults).toBeUndefined();
  });
});

describe('queries', () => {
  it('looks up a taxpayer', async () => {
    const mock = await start({
      taxpayers: [
        { taxNumber: '99887764', name: 'Beszerző Kft', shortName: 'Beszerző', valid: true },
      ],
    });
    const response = await clientFor(mock).queryTaxpayer({ taxNumber: '99887764' });
    expect(response.taxpayerValidity).toBe(true);
    expect(response.taxpayerData?.taxpayerName).toBe('Beszerző Kft');
  });

  it('reports an unknown taxpayer as invalid', async () => {
    const mock = await start();
    const response = await clientFor(mock).queryTaxpayer({ taxNumber: '12345678' });
    expect(response.taxpayerValidity).toBe(false);
  });

  it('lists submitted invoices in a date range', async () => {
    const mock = await start();
    const client = clientFor(mock);
    const invoice = sampleInvoice();
    await client.submitInvoices([{ operation: 'CREATE', invoice }]);

    const response = await client.queryInvoiceDigest({
      page: 1,
      invoiceDirection: 'OUTBOUND',
      invoiceQueryParams: {
        mandatoryQueryParams: {
          invoiceIssueDate: { dateFrom: '2021-01-01', dateTo: '2021-12-31' },
        },
      },
    });
    const digests = response.invoiceDigestResult.invoiceDigest ?? [];
    expect(digests.map((digest) => digest.invoiceNumber)).toEqual([invoice.invoiceNumber]);
  });

  it('excludes invoices outside the range', async () => {
    const mock = await start();
    const client = clientFor(mock);
    await client.submitInvoices([{ operation: 'CREATE', invoice: sampleInvoice() }]);

    const response = await client.queryInvoiceDigest({
      page: 1,
      invoiceDirection: 'OUTBOUND',
      invoiceQueryParams: {
        mandatoryQueryParams: {
          invoiceIssueDate: { dateFrom: '2030-01-01', dateTo: '2030-12-31' },
        },
      },
    });
    expect(response.invoiceDigestResult.invoiceDigest ?? []).toEqual([]);
  });

  it('returns a stored invoice that decodes back to what was sent', async () => {
    const mock = await start();
    const client = clientFor(mock);
    const invoice = sampleInvoice();
    await client.submitInvoices([{ operation: 'CREATE', invoice }]);

    const response = await client.queryInvoiceData({
      invoiceNumberQuery: {
        invoiceNumber: invoice.invoiceNumber,
        invoiceDirection: 'OUTBOUND',
      },
    });
    const result = response.invoiceDataResult!;
    expect(
      decodeInvoiceData(result.invoiceData, { compressed: result.compressedContentIndicator }),
    ).toEqual(invoice);
    expect(result.auditData.transactionId).toMatch(/^MOCKTX/);
  });

  it('answers an invoice check for a known and an unknown number', async () => {
    const mock = await start();
    const client = clientFor(mock);
    const invoice = sampleInvoice();
    await client.submitInvoices([{ operation: 'CREATE', invoice }]);

    const known = await client.queryInvoiceCheck({
      invoiceNumberQuery: { invoiceNumber: invoice.invoiceNumber, invoiceDirection: 'OUTBOUND' },
    });
    expect(known.invoiceCheckResult).toBe(true);

    const unknown = await client.queryInvoiceCheck({
      invoiceNumberQuery: { invoiceNumber: 'NOPE/1', invoiceDirection: 'OUTBOUND' },
    });
    expect(unknown.invoiceCheckResult).toBe(false);
  });

  it('lists transactions', async () => {
    const mock = await start();
    const client = clientFor(mock);
    await client.submitInvoices([{ operation: 'CREATE', invoice: sampleInvoice() }]);

    const response = await client.queryTransactionList({
      page: 1,
      insDate: { dateTimeFrom: '2020-01-01T00:00:00Z', dateTimeTo: '2035-01-01T00:00:00Z' },
    });
    const transactions = response.transactionListResult.transaction ?? [];
    expect(transactions).toHaveLength(1);
    expect(transactions[0]?.itemCount).toBe(1);
  });
});

describe('protocol handling', () => {
  it('rejects a GET', async () => {
    const mock = await start();
    const response = await fetch(`${mock.url}/tokenExchange`);
    expect(response.status).toBe(405);
  });

  it('rejects an unknown operation', async () => {
    const mock = await start();
    const response = await fetch(`${mock.url}/notAnOperation`, { method: 'POST', body: '<x/>' });
    expect(response.status).toBe(404);
  });

  it('reports unparseable XML rather than crashing', async () => {
    const mock = await start();
    const response = await fetch(`${mock.url}/tokenExchange`, {
      method: 'POST',
      body: 'not xml at all',
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('INVALID_REQUEST');
  });
});
