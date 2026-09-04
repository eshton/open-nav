import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NavApiError, parseDocument, type InvoiceData, type SoftwareType } from '@open-nav/core';
import {
  MAX_QUERY_DAYS,
  NavClient,
  chunkDateRange,
  downloadInvoices,
  iterateInvoiceDigests,
  type NavCredentials,
} from '@open-nav/client';
import { afterEach, describe, expect, it } from 'vitest';
import { startMockServer, type MockServer } from '../src/server.js';

/**
 * Bulk download, against a mock that enforces NAV's real limits: a digest
 * window may not exceed 35 days, and a supplier tax number may only be sent
 * when querying as the customer. Both are things a naive downloader gets
 * wrong, and both fail here rather than in production.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function baseInvoice(): InvoiceData {
  const xml = readFileSync(
    join(REPO_ROOT, 'conformance', 'data-samples', 'belfoldi-termekertekesites.xml'),
    'utf8',
  );
  return structuredClone(parseDocument(xml).value as InvoiceData);
}

/** An invoice issued to us by someone else, on a given date. */
function inboundInvoice(number: string, issueDate: string, supplier = '99887764'): InvoiceData {
  const invoice = baseInvoice();
  invoice.invoiceNumber = number;
  invoice.invoiceIssueDate = issueDate;
  const head = invoice.invoiceMain.invoice!.invoiceHead;
  head.supplierInfo.supplierTaxNumber.taxpayerId = supplier;
  head.customerInfo!.customerVatData!.customerTaxNumber!.taxpayerId = '99999999';
  return invoice;
}

const CREDENTIALS: NavCredentials = {
  login: 'pulllogin123',
  password: 'pull-password',
  signKey: 'pull-sign-key-0123456789',
  exchangeKey: '0123456789abcdef',
  taxNumber: '99999999',
};

const SOFTWARE: SoftwareType = {
  softwareId: 'OPENNAVPULL00001',
  softwareName: 'open-nav pull test',
  softwareOperation: 'LOCAL_SOFTWARE',
  softwareMainVersion: '0.1.0',
  softwareDevName: 'open-nav',
  softwareDevContact: 'dev@example.invalid',
};

let mock: MockServer | undefined;
afterEach(async () => {
  await mock?.close();
  mock = undefined;
});

async function withInbound(invoices: InvoiceData[]) {
  mock = await startMockServer({ credentials: CREDENTIALS, inboundInvoices: invoices });
  const client = new NavClient({
    credentials: CREDENTIALS,
    software: SOFTWARE,
    baseUrl: mock.url,
    transport: { retries: 0 },
  });
  return { client, mock };
}

describe('chunkDateRange', () => {
  it('leaves a short range alone', () => {
    expect(chunkDateRange('2025-01-01', '2025-01-20')).toEqual([
      { dateFrom: '2025-01-01', dateTo: '2025-01-20' },
    ]);
  });

  it('splits at 35 days, inclusive of both ends', () => {
    // 35 days apart is already over NAV's line, so a window spans 34 days.
    const windows = chunkDateRange('2025-01-01', '2025-03-31');
    expect(windows[0]).toEqual({ dateFrom: '2025-01-01', dateTo: '2025-02-04' });
    for (const window of windows) {
      const days =
        (Date.parse(`${window.dateTo}T00:00:00Z`) - Date.parse(`${window.dateFrom}T00:00:00Z`)) /
        86_400_000;
      expect(days).toBeLessThan(MAX_QUERY_DAYS);
    }
  });

  it('covers the whole range with no gap and no overlap', () => {
    const windows = chunkDateRange('2025-01-01', '2025-12-31');
    expect(windows[0]?.dateFrom).toBe('2025-01-01');
    expect(windows.at(-1)?.dateTo).toBe('2025-12-31');
    for (let i = 1; i < windows.length; i += 1) {
      const previousEnd = Date.parse(`${windows[i - 1]!.dateTo}T00:00:00Z`);
      const nextStart = Date.parse(`${windows[i]!.dateFrom}T00:00:00Z`);
      expect(nextStart - previousEnd).toBe(86_400_000);
    }
  });

  it('handles a single day', () => {
    expect(chunkDateRange('2025-06-01', '2025-06-01')).toEqual([
      { dateFrom: '2025-06-01', dateTo: '2025-06-01' },
    ]);
  });

  it('rejects a reversed or malformed range', () => {
    expect(() => chunkDateRange('2025-06-02', '2025-06-01')).toThrowError(/is after/);
    expect(() => chunkDateRange('06/01/2025', '2025-06-01')).toThrowError(/yyyy-mm-dd/);
  });
});

describe('downloading inbound invoices', () => {
  it('pulls a whole year, splitting the range NAV would refuse', async () => {
    // The mock rejects a window over 35 days, so this passing is the proof.
    const invoices = [
      inboundInvoice('SUP/2025/001', '2025-01-15'),
      inboundInvoice('SUP/2025/002', '2025-04-02'),
      inboundInvoice('SUP/2025/003', '2025-08-20'),
      inboundInvoice('SUP/2025/004', '2025-12-30'),
    ];
    const { client } = await withInbound(invoices);

    const downloaded = await downloadInvoices(client, {
      direction: 'INBOUND',
      dateFrom: '2025-01-01',
      dateTo: '2025-12-31',
      delayMs: 0,
    });

    expect(downloaded.map((entry) => entry.digest.invoiceNumber).sort()).toEqual([
      'SUP/2025/001',
      'SUP/2025/002',
      'SUP/2025/003',
      'SUP/2025/004',
    ]);
  });

  it('would be refused without chunking, which is what makes that test mean something', async () => {
    const { client } = await withInbound([inboundInvoice('SUP/2025/001', '2025-01-15')]);
    const error = (await client
      .queryInvoiceDigest({
        page: 1,
        invoiceDirection: 'INBOUND',
        invoiceQueryParams: {
          mandatoryQueryParams: {
            invoiceIssueDate: { dateFrom: '2025-01-01', dateTo: '2025-12-31' },
          },
        },
      })
      .catch((caught: unknown) => caught)) as NavApiError;
    expect(error).toBeInstanceOf(NavApiError);
    expect(error.message).toContain('BAD_QUERY_PARAM_RANGE_EXCEEDED');
  });

  it('returns the invoices decoded, and re-serialised for writing out', async () => {
    const invoice = inboundInvoice('SUP/2025/001', '2025-03-03');
    const { client } = await withInbound([invoice]);

    const [downloaded] = await downloadInvoices(client, {
      dateFrom: '2025-03-01',
      dateTo: '2025-03-31',
      delayMs: 0,
    });
    expect(downloaded?.invoice).toEqual(invoice);
    expect(downloaded?.xml).toContain('SUP/2025/001');
    expect(parseDocument(downloaded!.xml).value).toEqual(invoice);
    expect(downloaded?.auditData.transactionId).toMatch(/^MOCKIN/);
  });

  it('sends the supplier tax number the digest named, as inbound requires', async () => {
    // Without it NAV cannot resolve an inbound invoice; with it on an
    // outbound query NAV refuses. The direction decides.
    const { client, mock: server } = await withInbound([
      inboundInvoice('SUP/2025/009', '2025-05-05', '99887764'),
    ]);
    await downloadInvoices(client, { dateFrom: '2025-05-01', dateTo: '2025-05-31', delayMs: 0 });

    const dataRequest = server.state.requests.find((r) => r.operation === 'queryInvoiceData');
    expect(dataRequest?.body).toContain('<supplierTaxNumber>99887764</supplierTaxNumber>');
  });

  it('does not send a supplier tax number on an outbound pull', async () => {
    const { client, mock: server } = await withInbound([]);
    const invoice = baseInvoice();
    invoice.invoiceIssueDate = '2025-05-05';
    await client.submitInvoices([{ operation: 'CREATE', invoice }]);

    await downloadInvoices(client, {
      direction: 'OUTBOUND',
      dateFrom: '2025-05-01',
      dateTo: '2025-05-31',
      delayMs: 0,
    });
    const dataRequest = server.state.requests.find((r) => r.operation === 'queryInvoiceData');
    expect(dataRequest?.body).not.toContain('supplierTaxNumber');
  });

  it('keeps inbound and outbound apart', async () => {
    const { client } = await withInbound([inboundInvoice('SUP/2025/001', '2025-06-10')]);
    const own = baseInvoice();
    own.invoiceNumber = 'OWN/2025/001';
    own.invoiceIssueDate = '2025-06-11';
    await client.submitInvoices([{ operation: 'CREATE', invoice: own }]);

    const inbound = await downloadInvoices(client, {
      direction: 'INBOUND',
      dateFrom: '2025-06-01',
      dateTo: '2025-06-30',
      delayMs: 0,
    });
    const outbound = await downloadInvoices(client, {
      direction: 'OUTBOUND',
      dateFrom: '2025-06-01',
      dateTo: '2025-06-30',
      delayMs: 0,
    });
    expect(inbound.map((e) => e.digest.invoiceNumber)).toEqual(['SUP/2025/001']);
    expect(outbound.map((e) => e.digest.invoiceNumber)).toEqual(['OWN/2025/001']);
  });

  it('reports progress as it goes', async () => {
    const { client } = await withInbound([
      inboundInvoice('SUP/2025/001', '2025-07-01'),
      inboundInvoice('SUP/2025/002', '2025-07-02'),
    ]);
    const fetched: number[] = [];
    await downloadInvoices(client, {
      dateFrom: '2025-07-01',
      dateTo: '2025-07-31',
      delayMs: 0,
      onProgress: (progress) => fetched.push(progress.fetched),
    });
    expect(fetched).toEqual([1, 2]);
  });

  it('walks digests without fetching each invoice, for a cheap survey', async () => {
    const { client, mock: server } = await withInbound([
      inboundInvoice('SUP/2025/001', '2025-08-01'),
      inboundInvoice('SUP/2025/002', '2025-08-02'),
    ]);

    const numbers: string[] = [];
    for await (const { digest } of iterateInvoiceDigests(client, {
      dateFrom: '2025-08-01',
      dateTo: '2025-08-31',
      delayMs: 0,
    })) {
      numbers.push(digest.invoiceNumber);
    }
    expect(numbers).toHaveLength(2);
    // One digest request, and no per-invoice fetches.
    expect(server.state.requests.filter((r) => r.operation === 'queryInvoiceData')).toHaveLength(0);
  });

  it('returns nothing for a range with no invoices', async () => {
    const { client } = await withInbound([inboundInvoice('SUP/2025/001', '2025-01-15')]);
    expect(
      await downloadInvoices(client, {
        dateFrom: '2025-09-01',
        dateTo: '2025-09-30',
        delayMs: 0,
      }),
    ).toEqual([]);
  });

  it('paces itself between requests', async () => {
    const { client } = await withInbound([
      inboundInvoice('SUP/2025/001', '2025-10-01'),
      inboundInvoice('SUP/2025/002', '2025-10-02'),
    ]);
    const waits: number[] = [];
    await downloadInvoices(client, {
      dateFrom: '2025-10-01',
      dateTo: '2025-10-31',
      delayMs: 250,
      sleep: async (ms) => waits.push(ms),
    });
    // One pause per invoice fetch, plus paging.
    expect(waits.length).toBeGreaterThanOrEqual(2);
    expect(new Set(waits)).toEqual(new Set([250]));
  });
});
