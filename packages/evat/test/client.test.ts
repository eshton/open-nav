import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { requestSignature, sha3_512Bytes, NavApiError, type SoftwareType } from '@open-nav/core';
import { EvatClient, splitPartitions, VAT_DECLARATION } from '../src/client.js';
import { decodeDownloadPayload } from '../src/transport.js';
import { serializeDocument, parseDocument } from '../src/codec.js';
import type { EvatCredentials } from '../src/credentials.js';

const credentials: EvatCredentials = {
  login: 'techuser1',
  password: 'secret-password',
  signKey: 'ce-8f5e-215119fa7dd621DLMRHRLH2S',
  taxNumber: '12345678',
};

const software: SoftwareType = {
  softwareId: '12345678SZAMLAL01',
  softwareName: 'open-nav evat test',
  softwareOperation: 'LOCAL_SOFTWARE',
  softwareMainVersion: '0.1.0',
  softwareDevName: 'open-nav',
  softwareDevContact: 'dev@example.invalid',
  softwareDevCountryCode: 'HU',
  softwareDevTaxNumber: '12345678',
};

const FIXED = new Date('2026-05-15T10:20:30.000Z');

/** A fetch stub that records requests and replies with serialised responses. */
function stubFetch(responder: (url: string, init: RequestInit) => string) {
  const calls: Array<{ url: string; init: RequestInit; body: string }> = [];
  const fetch = (async (url: string | URL, init: RequestInit = {}) => {
    const body = typeof init.body === 'string' ? init.body : '[multipart]';
    calls.push({ url: String(url), init, body });
    return new Response(responder(String(url), init), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

function okUpload(): string {
  return serializeDocument('ManageDeclarationUploadResponse', {
    header: { requestId: 'R1', timestamp: '2026-05-15T10:20:30.000Z', requestVersion: '1.0' },
    result: { funcCode: 'OK' },
    declarationUploadId: 'UP-123',
    declarationUploadValidFrom: '2026-05-15T10:20:30Z',
    declarationUploadValidTo: '2026-05-18T10:20:30Z',
  });
}

function client(fetchImpl: typeof globalThis.fetch): EvatClient {
  return new EvatClient({
    credentials,
    software,
    baseUrl: 'https://evat.example/analyticsService/v1',
    now: () => FIXED,
    requestIdPrefix: 'TST',
    transport: { fetch: fetchImpl },
  });
}

describe('splitPartitions', () => {
  it('splits into chunks no larger than the max', () => {
    const bytes = new Uint8Array(Array.from({ length: 250 }, (_, i) => i % 256));
    const parts = splitPartitions(bytes, 100);
    expect(parts.map((p) => p.length)).toEqual([100, 100, 50]);
    expect(Buffer.concat(parts.map((p) => Buffer.from(p)))).toEqual(Buffer.from(bytes));
  });

  it('returns a single (empty) part for empty input', () => {
    expect(splitPartitions(new Uint8Array(), 100)).toHaveLength(1);
  });
});

describe('EvatClient signing', () => {
  it('signs an XML request as SHA3-512(requestId + ts + signKey)', async () => {
    const { fetch, calls } = stubFetch(() => okUpload());
    await client(fetch).manageDeclarationUpload({
      partitionCount: 1,
      contentHash: 'ABCD',
      xsdVersion: 'eardata_1.0',
      requestPeriodStart: '2026-04-01',
      requestPeriodEnd: '2026-04-30',
    });

    const req = parseDocument(calls[0]!.body).value as {
      header: { requestId: string; timestamp: string; requestVersion: string };
      user: {
        requestSignature: { value: string; cryptoType: string };
        passwordHash: { cryptoType: string };
      };
      declarationSchema: string;
    };
    const expected = requestSignature(
      req.header.requestId,
      req.header.timestamp,
      credentials.signKey,
    );
    expect(req.user.requestSignature.value).toBe(expected);
    expect(req.user.requestSignature.cryptoType).toBe('SHA3-512');
    expect(req.user.passwordHash.cryptoType).toBe('SHA-512');
    expect(req.header.requestVersion).toBe('1.0');
    expect(req.declarationSchema).toBe(VAT_DECLARATION);
    expect(calls[0]!.url).toBe('https://evat.example/analyticsService/v1/manageDeclarationUpload');
  });
});

describe('EvatClient submitDeclaration', () => {
  it('uploads, partitions (gzipped) and finalizes, hashing the raw XML', async () => {
    const declarationXml = `<VatDeclarationData>${'x'.repeat(500)}</VatDeclarationData>`;

    const { fetch, calls } = stubFetch((url) => {
      if (url.endsWith('/manageDeclarationUpload')) return okUpload();
      if (url.endsWith('/manageDeclarationPartition')) {
        return serializeDocument('ManageDeclarationPartitionResponse', {
          header: { requestId: 'R', timestamp: '2026-05-15T10:20:30.000Z', requestVersion: '1.0' },
          result: { funcCode: 'OK' },
          declarationUploadId: 'UP-123',
          partition: 1,
        });
      }
      if (url.endsWith('/manageDeclarationFinalize')) {
        return serializeDocument('ManageDeclarationFinalizeResponse', {
          header: { requestId: 'R', timestamp: '2026-05-15T10:20:30.000Z', requestVersion: '1.0' },
          result: { funcCode: 'OK' },
          declarationProcessingId: 'PROC-9',
        });
      }
      throw new Error(`unexpected ${url}`);
    });

    const result = await client(fetch).submitDeclaration({
      declarationXml,
      xsdVersion: 'eardata_1.0',
      requestPeriodStart: '2026-04-01',
      requestPeriodEnd: '2026-04-30',
      maxPartitionBytes: 1_000_000,
    });

    expect(result.declarationUploadId).toBe('UP-123');
    expect(result.declarationProcessingId).toBe('PROC-9');
    expect(result.partitionCount).toBe(1);

    // Sequence: upload, one partition, finalize.
    expect(calls.map((c) => c.url.split('/').pop())).toEqual([
      'manageDeclarationUpload',
      'manageDeclarationPartition',
      'manageDeclarationFinalize',
    ]);

    // The upload declared the SHA3-512 of the *uncompressed* XML.
    const upload = parseDocument(calls[0]!.body).value as {
      contentHash: { value: string };
      partitionCount: number;
    };
    expect(upload.contentHash.value).toBe(sha3_512Bytes(new TextEncoder().encode(declarationXml)));
    expect(upload.partitionCount).toBe(1);
  });
});

describe('EvatClient queries', () => {
  it('sends a declaration-list query with the date window', async () => {
    const { fetch, calls } = stubFetch(() =>
      serializeDocument('QueryDeclarationListResponse', {
        header: { requestId: 'R', timestamp: '2026-05-15T10:20:30.000Z', requestVersion: '1.0' },
        result: { funcCode: 'OK' },
      }),
    );
    await client(fetch).queryDeclarationList({
      taxpointDateFrom: '2026-01-01',
      taxpointDateTo: '2026-03-31',
    });
    const req = parseDocument(calls[0]!.body).value as {
      taxpointDateFrom: string;
      taxpointDateTo: string;
    };
    expect(calls[0]!.url).toBe('https://evat.example/analyticsService/v1/queryDeclarationList');
    expect(req.taxpointDateFrom).toBe('2026-01-01');
    expect(req.taxpointDateTo).toBe('2026-03-31');
  });

  it('downloads declaration data from a multipart response', async () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const responseXml = serializeDocument('QueryDeclarationDataResponse', {
      header: { requestId: 'R', timestamp: '2026-05-15T10:20:30.000Z', requestVersion: '1.0' },
      result: { funcCode: 'OK' },
    });
    const fetch = (async () => {
      const form = new FormData();
      form.append('response', new Blob([responseXml], { type: 'application/xml' }));
      form.append('data', new Blob([payload], { type: 'application/octet-stream' }));
      return new Response(form, { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const download = await client(fetch).queryDeclarationData('PROC-9');
    expect(download.root).toBe('QueryDeclarationDataResponse');
    expect(download.payload).toEqual(payload);
  });

  it('reads the compiled VAT data from the gzipped `file` part and decodes it', async () => {
    const declarationXml = '<VatDeclarationData>…</VatDeclarationData>';
    const gz = gzipSync(Buffer.from(declarationXml, 'utf8'));
    const responseXml = serializeDocument('QueryVatDeclarationDataResponse', {
      header: { requestId: 'R', timestamp: '2026-05-15T10:20:30.000Z', requestVersion: '1.0' },
      result: { funcCode: 'OK' },
    });
    const fetch = (async () => {
      // NAV's real shape: a `body` XML part and a `file` octet-stream part with
      // no filename, carrying gzip bytes.
      const form = new FormData();
      form.append('body', new Blob([responseXml], { type: 'application/xml' }));
      form.append('file', new Blob([gz], { type: 'application/octet-stream' }));
      return new Response(form, { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const download = await client(fetch).queryVatDeclarationData('PROC-9');
    expect(download.root).toBe('QueryVatDeclarationDataResponse');
    expect(new Uint8Array(download.payload!)).toEqual(new Uint8Array(gz));
    expect(decodeDownloadPayload(download.payload!)).toBe(declarationXml);
  });
});

describe('EvatClient errors', () => {
  it('raises NavApiError on an ERROR verdict', async () => {
    const { fetch } = stubFetch(() =>
      serializeDocument('ManageDeclarationUploadResponse', {
        header: { requestId: 'R', timestamp: '2026-05-15T10:20:30.000Z', requestVersion: '1.0' },
        result: { funcCode: 'ERROR', errorCode: 'INVALID_SECURITY_USER', message: 'bad login' },
        declarationUploadId: 'x',
        declarationUploadValidFrom: '2026-05-15T10:20:30Z',
        declarationUploadValidTo: '2026-05-18T10:20:30Z',
      }),
    );
    await expect(
      client(fetch).manageDeclarationUpload({
        partitionCount: 1,
        contentHash: 'ABCD',
        xsdVersion: 'eardata_1.0',
        requestPeriodStart: '2026-04-01',
        requestPeriodEnd: '2026-04-30',
      }),
    ).rejects.toBeInstanceOf(NavApiError);
  });
});
