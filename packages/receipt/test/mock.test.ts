import { describe, expect, it } from 'vitest';
import { createReceiptMock } from '../src/mock.js';
import { ReceiptRegistrationClient } from '../src/registration.js';
import { ReceiptClient } from '../src/client.js';
import { generateRsaKeyPair } from '../src/crypto.js';
import type { SoftwareType } from '../src/generated/types.js';

const software: SoftwareType = {
  softwareId: '12345678SZAMLAL01',
  softwareName: 'open-nav receipt mock',
  softwareOperation: 'LOCAL_SOFTWARE',
  softwareMainVersion: '0.1.0',
  softwareDevName: 'open-nav',
  softwareDevContact: 'dev@example.invalid',
  softwareDevCountryCode: 'HU',
  softwareDevTaxNumber: '12345678',
  softwareHash: 'ABC123',
  softwareLastUpdateTime: '2026-01-01T00:00:00Z',
};

const signing = generateRsaKeyPair(2048);

describe('createReceiptMock', () => {
  it('runs the whole lifecycle without certificates', async () => {
    const mock = createReceiptMock();

    // Bootstrap: register + download a certificate.
    const registration = new ReceiptRegistrationClient({
      software,
      transport: { fetch: mock.fetch },
    });
    const reg = await registration.register({
      apNumber: 'AP12345678',
      registrationNumber: 'INSTALL-1',
      imei: '350000000000001',
      imsi: '216300000000001',
    });
    expect(reg.authentication?.csrDerBase64).toBeDefined();
    const cert = await registration.downloadCertificate('https://fam.example/cert', 0);
    expect(cert).toContain('BEGIN CERTIFICATE');

    // Data services over the same mock fetch.
    const client = new ReceiptClient({
      apNumber: 'AP12345678',
      transport: { fetch: mock.fetch },
    });

    const hello = await client.hello({ currentOperatorSiteProcessId: 'PROC-1' });
    expect(hello.result.funcCode).toBe('OK');

    const doc = await client.submitDocument({
      taxNumber: '12345678',
      documentClass: 'RECEIPT',
      searchKey: 'SK-1',
      searchKeyTimestamp: '2026-05-15T09:59:00Z',
      recordCounter: 2,
      lastRecordCounter: 1,
      ntcaVerificationCode: 'CODE',
      qRCodeExpired: false,
      offlineCreated: false,
      cashRegisterSignCertificate: 'BASE64DER',
      coreDocumentXml: '<CoreDocument><n>1</n></CoreDocument>',
      customerDocumentXml: '<CustomerDocument><b>x</b></CustomerDocument>',
      signingKeyPem: signing.privateKey,
    });
    expect(doc.result.funcCode).toBe('OK');
    expect(doc.APNumber).toBe('AP12345678');

    const report = await client.submitReport({
      taxNumber: '12345678',
      reportClass: 'CASHREGISTER',
      searchKey: 'SK-2',
      searchKeyTimestamp: '2026-05-15T10:00:00Z',
      recordCounter: 3,
      lastRecordCounter: 2,
      ntcaVerificationCode: 'CODE2',
      qRCodeExpired: false,
      offlineCreated: false,
      cashRegisterSignCertificate: 'BASE64DER',
      coreReportXml: '<CoreReport><total>100</total></CoreReport>',
      signingKeyPem: signing.privateKey,
    });
    expect(report.result.funcCode).toBe('OK');

    const taxpayer = await client.queryTaxpayer('12345678');
    expect(taxpayer.taxpayerValidity).toBe(true);

    const product = await client.getProductByCode('01012100');
    expect(product.result.funcCode).toBe('OK');
    expect(product.numberOfProducts).toBe(0);

    const ops = mock.state.requests.map((r) => r.operation);
    expect(ops).toEqual([
      'register',
      'cert',
      'hello',
      'document',
      'report',
      'queryTaxpayer',
      'getProductByCode',
    ]);
  });

  it('rejects a submission whose envelope is missing', async () => {
    const mock = createReceiptMock();
    // A raw DocumentRequest with no envelope should be refused by the mock.
    const res = await mock.fetch('https://data.example/document', {
      method: 'POST',
      body: '<DocumentRequest xmlns="http://schemas.nav.gov.hu/EPCR/1.0/api"><APNumber>AP1</APNumber></DocumentRequest>',
    });
    const text = await res.text();
    expect(text).toContain('INVALID_ENVELOPE');
  });
});
