import { NavInvoiceRejectedError, NavTransportError } from '@open-nav/core';
import { describe, expect, it } from 'vitest';
import { NavClient } from '../src/client.js';
import { listTransactions, waitForTransaction } from '../src/transaction.js';
import { CREDENTIALS, SOFTWARE, stubFetch, transactionStatusResponse } from './support.js';

/** Sleeps are injected, so these tests are instant and deterministic. */
const noSleep = async (): Promise<void> => {};

function clientFor(bodies: string[]) {
  const { fetch, requests } = stubFetch((_url, _body, call) => ({
    body: bodies[Math.min(call, bodies.length - 1)]!,
  }));
  const client = new NavClient({
    credentials: CREDENTIALS,
    software: SOFTWARE,
    baseUrl: 'https://nav.example.invalid/invoiceService/v1',
    transport: { fetch, retries: 0 },
  });
  return { client, requests };
}

describe('waitForTransaction', () => {
  it('polls until every invoice is terminal', async () => {
    const { client, requests } = clientFor([
      transactionStatusResponse([{ index: 1, invoiceStatus: 'RECEIVED' }]),
      transactionStatusResponse([{ index: 1, invoiceStatus: 'PROCESSING' }]),
      transactionStatusResponse([{ index: 1, invoiceStatus: 'DONE' }]),
    ]);

    const seen: string[][] = [];
    const outcome = await waitForTransaction(client, 'TX1', {
      sleep: noSleep,
      onPoll: (results) => seen.push(results.map((result) => result.invoiceStatus)),
    });

    expect(requests).toHaveLength(3);
    expect(seen).toEqual([['RECEIVED'], ['PROCESSING'], ['DONE']]);
    expect(outcome.accepted.map((result) => result.index)).toEqual([1]);
    expect(outcome.rejected).toEqual([]);
  });

  it('keeps waiting while NAV has no per-invoice results yet', async () => {
    // An accepted batch with an empty result set is still in progress.
    const { client, requests } = clientFor([
      transactionStatusResponse([]),
      transactionStatusResponse([{ index: 1, invoiceStatus: 'DONE' }]),
    ]);
    const outcome = await waitForTransaction(client, 'TX1', { sleep: noSleep });
    expect(requests).toHaveLength(2);
    expect(outcome.accepted).toHaveLength(1);
  });

  it('separates accepted, rejected and warned invoices', async () => {
    const { client } = clientFor([
      transactionStatusResponse([
        { index: 1, invoiceStatus: 'DONE' },
        {
          index: 2,
          invoiceStatus: 'DONE',
          businessValidationMessages: [
            {
              validationResultCode: 'WARN',
              validationErrorCode: 'INVOICE_ISSUE_DATE_EARLY',
              message: 'issue date is unusually early',
            },
          ],
        },
        {
          index: 3,
          invoiceStatus: 'ABORTED',
          businessValidationMessages: [
            {
              validationResultCode: 'ERROR',
              validationErrorCode: 'INVALID_CUSTOMER_VAT_STATUS',
              message: 'customerVatStatus does not match customerVatData',
            },
          ],
        },
      ]),
    ]);

    const outcome = await waitForTransaction(client, 'TX1', { sleep: noSleep });

    expect(outcome.accepted.map((result) => result.index)).toEqual([1, 2]);
    expect(outcome.warnings.map((result) => result.index)).toEqual([2]);
    expect(outcome.rejected.map((result) => result.index)).toEqual([3]);
  });

  it('returns results in batch index order regardless of response order', async () => {
    const { client } = clientFor([
      transactionStatusResponse([
        { index: 3, invoiceStatus: 'DONE' },
        { index: 1, invoiceStatus: 'DONE' },
        { index: 2, invoiceStatus: 'DONE' },
      ]),
    ]);
    const outcome = await waitForTransaction(client, 'TX1', { sleep: noSleep });
    expect(outcome.results.map((result) => result.index)).toEqual([1, 2, 3]);
  });

  it('can throw on rejection, carrying NAV error codes', async () => {
    const { client } = clientFor([
      transactionStatusResponse([
        {
          index: 1,
          invoiceStatus: 'ABORTED',
          businessValidationMessages: [
            {
              validationResultCode: 'ERROR',
              validationErrorCode: 'INVALID_SUMMARY',
              message: 'summary does not reconcile with the lines',
            },
          ],
        },
      ]),
    ]);

    const error = (await waitForTransaction(client, 'TX9', {
      sleep: noSleep,
      throwOnRejection: true,
    }).catch((caught: unknown) => caught)) as NavInvoiceRejectedError;

    expect(error).toBeInstanceOf(NavInvoiceRejectedError);
    expect(error.transactionId).toBe('TX9');
    expect(error.message).toContain('INVALID_SUMMARY');
    expect(error.rejected[0]?.index).toBe(1);
  });

  it('times out rather than polling forever', async () => {
    const { client } = clientFor([
      transactionStatusResponse([{ index: 1, invoiceStatus: 'PROCESSING' }]),
    ]);
    await expect(
      waitForTransaction(client, 'TX1', { sleep: noSleep, timeoutMs: 0 }),
    ).rejects.toThrowError(NavTransportError);
  });

  it('reports the last seen status in the timeout message', async () => {
    const { client } = clientFor([
      transactionStatusResponse([{ index: 1, invoiceStatus: 'PROCESSING' }]),
    ]);
    await expect(
      waitForTransaction(client, 'TX1', { sleep: noSleep, timeoutMs: 0 }),
    ).rejects.toThrowError(/#1 PROCESSING/);
  });
});

describe('listTransactions', () => {
  function fakeClient(pages: Array<Record<string, unknown>>) {
    const calls: Array<{ page: number; insDate: { dateTimeFrom: string; dateTimeTo: string } }> =
      [];
    const client = {
      async queryTransactionList(body: {
        page: number;
        insDate: { dateTimeFrom: string; dateTimeTo: string };
      }) {
        calls.push(body);
        return { transactionListResult: pages[body.page - 1] };
      },
    } as unknown as NavClient;
    return { client, calls };
  }

  it('covers the Hungarian local day (DST-aware) as UTC instants', async () => {
    const { client, calls } = fakeClient([{ currentPage: 1, availablePage: 1, transaction: [] }]);
    await listTransactions(client, { from: '2026-08-03', to: '2026-08-03' });
    // Start at earliest local midnight (CEST +02) → prev day 22:00Z; end at latest
    // local end-of-day (CET +01) → 22:59:59.999Z. Covers the day in both DST states.
    expect(calls[0]!.insDate.dateTimeFrom).toBe('2026-08-02T22:00:00.000Z');
    expect(calls[0]!.insDate.dateTimeTo).toBe('2026-08-03T22:59:59.999Z');
  });

  it('walks every page and returns newest first', async () => {
    const { client, calls } = fakeClient([
      {
        currentPage: 1,
        availablePage: 2,
        transaction: [{ insDate: '2026-08-03T10:00:00Z', transactionId: 'a' }],
      },
      {
        currentPage: 2,
        availablePage: 2,
        transaction: [{ insDate: '2026-08-03T12:00:00Z', transactionId: 'b' }],
      },
    ]);
    const out = await listTransactions(client, { from: '2026-08-03', to: '2026-08-03' });
    expect(out.map((t) => t.transactionId)).toEqual(['b', 'a']);
    expect(calls.map((c) => c.page)).toEqual([1, 2]);
  });

  it('stops rather than spinning when currentPage is missing', async () => {
    const { client, calls } = fakeClient([{ availablePage: 5, transaction: [] }]);
    await listTransactions(client, { from: '2026-08-01', to: '2026-08-31' });
    expect(calls).toHaveLength(1);
  });
});
