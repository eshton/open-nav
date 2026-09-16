import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { EvatClient } from '../src/client.js';
import {
  chunkTaxpointRange,
  queryAllDeclarations,
  queryAllStatements,
  queryAllDocuments,
  readVatDeclaration,
  summariseDeclaration,
} from '../src/query.js';
import { serializeDocument } from '../src/codec.js';
import type { EvatCredentials } from '../src/credentials.js';
import type { SoftwareType } from '@open-nav/core';

describe('chunkTaxpointRange', () => {
  it('returns one window for a range within 35 days', () => {
    expect(chunkTaxpointRange('2026-01-01', '2026-01-31')).toEqual([
      { taxpointDateFrom: '2026-01-01', taxpointDateTo: '2026-01-31' },
    ]);
  });

  it('splits a long range into inclusive 35-day windows', () => {
    const windows = chunkTaxpointRange('2026-01-01', '2026-03-31');
    expect(windows).toEqual([
      { taxpointDateFrom: '2026-01-01', taxpointDateTo: '2026-02-04' }, // 35 days inclusive
      { taxpointDateFrom: '2026-02-05', taxpointDateTo: '2026-03-11' },
      { taxpointDateFrom: '2026-03-12', taxpointDateTo: '2026-03-31' },
    ]);
    // No window exceeds the 35-day cap.
    for (const w of windows) {
      const days = (Date.parse(w.taxpointDateTo) - Date.parse(w.taxpointDateFrom)) / 86_400_000;
      expect(days).toBeLessThanOrEqual(34);
    }
  });

  it('rejects a reversed range', () => {
    expect(() => chunkTaxpointRange('2026-02-01', '2026-01-01')).toThrow(/after/);
  });
});

const credentials: EvatCredentials = {
  login: 'tech-user',
  password: 'pw',
  signKey: 'sign-key',
  taxNumber: '12345678',
};
const software: SoftwareType = {
  softwareId: 'OPENNAVTEST000001',
  softwareName: 'open-nav test',
  softwareOperation: 'LOCAL_SOFTWARE',
  softwareMainVersion: '0.1.0',
  softwareDevName: 'open-nav',
  softwareDevContact: 'dev@example.invalid',
  softwareDevCountryCode: 'HU',
  softwareDevTaxNumber: '12345678',
};

function listResponse(ids: string[]): string {
  return serializeDocument('QueryDeclarationListResponse', {
    header: { requestId: 'R', timestamp: '2026-01-01T00:00:00.000Z', requestVersion: '1.0' },
    result: { funcCode: 'OK' },
    declarationList: {
      declarationListItem: ids.map((id) => ({
        declarationProcessingId: id,
        declarationSchema: 'VAT_DECLARATION',
        originalRequestVersion: '1.0',
      })),
    },
  });
}

describe('queryAllDeclarations', () => {
  it('walks every 35-day window and flattens the items', async () => {
    const windows: string[] = [];
    const fetch = (async (url: string | URL, init: RequestInit = {}) => {
      const body = typeof init.body === 'string' ? init.body : '';
      const from = /<[^>]*taxpointDateFrom>([^<]+)</.exec(body)?.[1] ?? '';
      windows.push(from);
      // One item in the first window, none after — proves aggregation + looping.
      return new Response(listResponse(windows.length === 1 ? ['PROC-1'] : []), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const client = new EvatClient({ credentials, software, transport: { fetch } });
    const items = await queryAllDeclarations(client, {
      taxpointDateFrom: '2026-01-01',
      taxpointDateTo: '2026-03-31',
    });

    expect(windows).toEqual(['2026-01-01', '2026-02-05', '2026-03-12']); // 3 windows
    expect(items.map((i) => i.declarationProcessingId)).toEqual(['PROC-1']);
  });
});

function okHeader() {
  return { requestId: 'R', timestamp: '2026-01-01T00:00:00.000Z', requestVersion: '1.0' };
}

describe('queryAllStatements', () => {
  it('flattens statementList (the traditional returns), not declarationList', async () => {
    const fetch = (async () =>
      new Response(
        serializeDocument('QueryDeclarationListResponse', {
          header: okHeader(),
          result: { funcCode: 'OK' },
          statementList: {
            statementListItem: [
              {
                declarationProcessingId: 'STMT-1',
                declarationSchema: 'VAT_DECLARATION',
                originalRequestVersion: '1.0',
              },
            ],
          },
        }),
        { status: 200 },
      )) as unknown as typeof globalThis.fetch;

    const client = new EvatClient({ credentials, software, transport: { fetch } });
    const items = await queryAllStatements(client, {
      taxpointDateFrom: '2026-01-01',
      taxpointDateTo: '2026-01-31',
    });
    expect(items.map((i) => i.declarationProcessingId)).toEqual(['STMT-1']);
  });
});

describe('queryAllDocuments', () => {
  it('resolves the async queryId, polling until DONE', async () => {
    let resultCalls = 0;
    const fetch = (async (url: string | URL) => {
      const op = String(url).split('/').pop();
      if (op === 'queryDocumentList') {
        return new Response(
          serializeDocument('QueryDocumentListResponse', {
            header: okHeader(),
            result: { funcCode: 'OK' },
            queryId: 'Q-1',
          }),
          { status: 200 },
        );
      }
      // First poll PROCESSING, then DONE.
      resultCalls++;
      return new Response(
        serializeDocument('QueryDocumentListResultResponse', {
          header: okHeader(),
          result: { funcCode: 'OK' },
          documentList: { queryResultStatus: resultCalls === 1 ? 'PROCESSING' : 'DONE' },
        }),
        { status: 200 },
      );
    }) as unknown as typeof globalThis.fetch;

    const client = new EvatClient({ credentials, software, transport: { fetch } });
    const lists = await queryAllDocuments(
      client,
      { taxpointDateFrom: '2026-01-01', taxpointDateTo: '2026-01-31' },
      { intervalMs: 0 },
    );
    expect(lists).toHaveLength(1);
    expect(lists[0]!.queryResultStatus).toBe('DONE');
    expect(resultCalls).toBe(2); // polled once more after PROCESSING
  });
});

describe('readVatDeclaration', () => {
  it('downloads and gunzips the compiled return to XML', async () => {
    const xml = '<VatDeclarationData>…</VatDeclarationData>';
    const gz = gzipSync(Buffer.from(xml, 'utf8'));
    const fetch = (async () => {
      const form = new FormData();
      form.append(
        'body',
        new Blob(
          [
            serializeDocument('QueryVatDeclarationDataResponse', {
              header: okHeader(),
              result: { funcCode: 'OK' },
            }),
          ],
          { type: 'application/xml' },
        ),
      );
      form.append('file', new Blob([gz], { type: 'application/octet-stream' }));
      return new Response(form, { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const client = new EvatClient({ credentials, software, transport: { fetch } });
    expect(await readVatDeclaration(client, 'PROC-1')).toBe(xml);
  });
});

describe('summariseDeclaration', () => {
  it('flattens an analytics declaration item', () => {
    const row = summariseDeclaration({
      declarationProcessingId: 'PID-1',
      declarationSchema: 'http://schemas.nav.gov.hu/2018/xml',
      declarationInfo: {
        taxNumber: '12345678',
        declarationPeriodStart: '2026-01-01',
        declarationPeriodEnd: '2026-01-31',
        declarationType: 'A60',
        declarationMethod: 'BASE',
        declarationFrequency: 'MONTHLY',
        version: 2,
      },
    } as never);
    expect(row).toMatchObject({
      processingId: 'PID-1',
      taxNumber: '12345678',
      periodStart: '2026-01-01',
      periodEnd: '2026-01-31',
      isStatement: false,
      declarationType: 'A60',
      method: 'BASE',
      frequency: 'MONTHLY',
      version: 2,
    });
  });

  it('flattens a traditional statement item and marks isStatement', () => {
    const row = summariseDeclaration({
      declarationProcessingId: 'PID-2',
      declarationSchema: 'schema',
      statementInfo: {
        vatIdentificationNumber: 87654321,
        statementPeriodStart: '2026-02-01',
        statementPeriodEnd: '2026-02-28',
        statementMethod: 'SELF_CHECK',
        statementFrequency: 'QUARTERLY',
        version: 1,
      },
    } as never);
    expect(row).toMatchObject({
      processingId: 'PID-2',
      taxNumber: '87654321',
      isStatement: true,
      declarationType: null,
      method: 'SELF_CHECK',
      frequency: 'QUARTERLY',
      version: 1,
    });
  });
});
