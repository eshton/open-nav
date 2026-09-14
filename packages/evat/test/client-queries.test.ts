import { describe, expect, it } from 'vitest';
import type { SoftwareType } from '@open-nav/core';
import { EvatClient } from '../src/client.js';
import { serializeDocument } from '../src/codec.js';
import type { EvatCredentials } from '../src/credentials.js';

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

/** interpret() only reads result.funcCode, so an OK envelope drives any op. */
function stub() {
  const calls: string[] = [];
  const okBody = serializeDocument('QueryDeclarationListResponse', {
    header: { requestId: 'R', timestamp: '2026-01-01T00:00:00.000Z', requestVersion: '1.0' },
    result: { funcCode: 'OK' },
  });
  const fetch = (async (url: string | URL) => {
    calls.push(String(url).split('/').pop() ?? '');
    return new Response(okBody, { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

describe('EvatClient simple operations', () => {
  it('drives the primitive-argument operations to their endpoints', async () => {
    const { fetch, calls } = stub();
    const client = new EvatClient({ credentials, software, transport: { fetch } });

    await client.queryTaxCodeCatalog('2026-05-15');
    await client.queryDeclarationProcessingStatus('PROC-1');
    await client.manageDeclarationSubmission('PROC-1');
    await client.queryDocumentListResult('Q-1');
    await client.queryAttachmentList();
    await client.purgeAttachment('CLAIM-1');
    await client.manageAttachmentUpload(
      { fileName: 'a', fileExtension: 'PDF' },
      new Uint8Array([1, 2, 3]),
    );

    expect(calls).toEqual([
      'queryTaxCodeCatalog',
      'queryDeclarationProcessingStatus',
      'manageDeclarationSubmission',
      'queryDocumentListResult',
      'queryAttachmentList',
      'purgeAttachment',
      'manageAttachmentUpload',
    ]);
  });
});
