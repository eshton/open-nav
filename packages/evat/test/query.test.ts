import { describe, expect, it } from 'vitest';
import { EvatClient } from '../src/client.js';
import { chunkTaxpointRange, queryAllDeclarations } from '../src/query.js';
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
