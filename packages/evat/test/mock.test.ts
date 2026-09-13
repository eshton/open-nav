import { describe, expect, it } from 'vitest';
import type { SoftwareType } from '@open-nav/core';
import { EvatClient } from '../src/client.js';
import { createEvatMock } from '../src/mock.js';
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

function clientFor(mock: ReturnType<typeof createEvatMock>): EvatClient {
  return new EvatClient({
    credentials,
    software,
    baseUrl: 'https://mock/analyticsService/v1',
    transport: { fetch: mock.fetch },
  });
}

describe('createEvatMock — full lifecycle', () => {
  it('runs upload → partition → finalize → poll → submission', async () => {
    const mock = createEvatMock({ credentials, pollsBeforeDone: 1 });
    const client = clientFor(mock);

    const submitted = await client.submitDeclaration({
      declarationXml: `<VatDeclarationData>${'y'.repeat(2000)}</VatDeclarationData>`,
      xsdVersion: 'eardata_1.0',
      requestPeriodStart: '2026-04-01',
      requestPeriodEnd: '2026-04-30',
    });
    expect(submitted.declarationUploadId).toMatch(/^UP/);
    expect(submitted.declarationProcessingId).toMatch(/^PROC/);
    expect(submitted.partitionCount).toBe(1);

    // Poll: RECEIVED first (pollsBeforeDone=1), then FINISHED.
    const first = await client.queryDeclarationProcessingStatus(submitted.declarationProcessingId);
    expect(first.declarationProcessingStatus?.declarationStatus?.declarationStatusCode).toBe(
      'RECEIVED',
    );
    const second = await client.queryDeclarationProcessingStatus(submitted.declarationProcessingId);
    expect(second.declarationProcessingStatus?.declarationStatus?.declarationStatusCode).toBe(
      'FINISHED',
    );

    const submission = await client.manageDeclarationSubmission(submitted.declarationProcessingId);
    expect(submission.result.funcCode).toBe('OK');

    // The mock recorded upload, one partition, finalize, two status polls, submission.
    expect(mock.state.requests.map((r) => r.operation)).toEqual([
      'manageDeclarationUpload',
      'manageDeclarationPartition',
      'manageDeclarationFinalize',
      'queryDeclarationProcessingStatus',
      'queryDeclarationProcessingStatus',
      'manageDeclarationSubmission',
    ]);
  });

  it('rejects wrong credentials with INVALID_SECURITY_USER', async () => {
    const mock = createEvatMock({ credentials });
    const client = new EvatClient({
      credentials: { ...credentials, login: 'someoneelse' },
      software,
      baseUrl: 'https://mock/analyticsService/v1',
      transport: { fetch: mock.fetch },
    });
    await expect(
      client.queryDeclarationList({ taxpointDateFrom: '2026-01-01', taxpointDateTo: '2026-03-31' }),
    ).rejects.toMatchObject({ errorCode: 'INVALID_SECURITY_USER' });
  });

  it('serves a declaration-data download with its payload', async () => {
    const payload = new Uint8Array([9, 8, 7]);
    const mock = createEvatMock({ credentials, declarationDataPayload: payload });
    const download = await clientFor(mock).queryDeclarationData('PROC-1');
    expect(download.root).toBe('QueryDeclarationDataResponse');
    expect(download.payload).toEqual(payload);
  });
});
