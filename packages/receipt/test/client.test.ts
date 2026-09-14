import { describe, expect, it } from 'vitest';
import { ReceiptClient } from '../src/client.js';
import { parseDocument, serializeDocument } from '../src/codec.js';
import { openEnvelope, verifyEnvelopeSignature } from '../src/envelope.js';
import { generateRsaKeyPair } from '../src/crypto.js';
import { canonicalize } from '../src/canon.js';
import type { SignedDocumentEnvelopeType } from '../src/generated/types.js';

const keys = generateRsaKeyPair(2048);

function stub() {
  const calls: Array<{ url: string; body: string }> = [];
  const fetch = (async (url: string | URL, init: RequestInit = {}) => {
    const body = typeof init.body === 'string' ? init.body : '';
    calls.push({ url: String(url), body });
    return new Response(
      serializeDocument('GeneralErrorHeaderResponse', {
        header: { requestId: 'R', timestamp: '2026-01-01T00:00:00.000Z', requestVersion: '1.0' },
        result: { funcCode: 'OK' },
      }),
      { status: 200 },
    );
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

function client(fetch: typeof globalThis.fetch) {
  return new ReceiptClient({
    apNumber: 'AP12345678',
    baseUrl: 'https://data.example',
    now: () => new Date('2026-05-15T10:00:00Z'),
    transport: { fetch },
  });
}

describe('ReceiptClient', () => {
  it('submits a document, wrapping the payloads in a signed envelope', async () => {
    const { fetch, calls } = stub();
    const core = '<CoreDocument><n>1</n></CoreDocument>';
    const customer = '<CustomerDocument><b>x</b></CustomerDocument>';

    await client(fetch).submitDocument({
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
      coreDocumentXml: core,
      customerDocumentXml: customer,
      signingKeyPem: keys.privateKey,
    });

    expect(calls[0]!.url).toBe('https://data.example/eReceiptMgmt/v1/document');
    const req = parseDocument(calls[0]!.body).value as {
      APNumber: string;
      documentClass: string;
      decryptKey: string;
      documentEnvelope: SignedDocumentEnvelopeType;
    };
    expect(req.APNumber).toBe('AP12345678');
    expect(req.documentClass).toBe('RECEIPT');

    // The envelope on the wire verifies and decrypts back to the source XML.
    expect(verifyEnvelopeSignature(req.documentEnvelope, keys.publicKey)).toBe(true);
    const opened = openEnvelope(req.documentEnvelope, req.decryptKey);
    expect(opened.core).toBe(canonicalize(core));
    expect(opened.customer).toBe(canonicalize(customer));
  });

  it('carries the optional fields and submits a report to the report endpoint', async () => {
    const { fetch, calls } = stub();
    await client(fetch).submitReport({
      taxNumber: '12345678',
      groupIdentificationNumber: '99999999',
      reportClass: 'CASHREGISTER',
      searchKey: 'SK-2',
      searchKeyTimestamp: '2026-05-15T10:00:00Z',
      recordCounter: 3,
      lastRecordCounter: 2,
      ntcaVerificationCode: 'CODE2',
      qRCodeExpired: true,
      offlineCreated: true,
      cashRegisterSignCertificate: 'BASE64DER',
      sendMissingDocumentProcessId: 'PROC-MISSING',
      coreReportXml: '<CoreReport><t>1</t></CoreReport>',
      customerReportXml: '<CustomerReport><b>y</b></CustomerReport>',
      signingKeyPem: keys.privateKey,
    });
    expect(calls[0]!.url).toBe('https://data.example/eReceipt/v1/report');
    const req = parseDocument(calls[0]!.body).value as {
      groupIdentificationNumber: string;
      sendMissingDocumentProcessId: string;
      reportEnvelope: SignedDocumentEnvelopeType;
    };
    expect(req.groupIdentificationNumber).toBe('99999999');
    expect(req.sendMissingDocumentProcessId).toBe('PROC-MISSING');
    // A report with customer data carries both envelope payloads.
    expect(req.reportEnvelope.customerEnvelopeData).toBeDefined();
  });

  it('passes optional hello process ids through', async () => {
    const { fetch, calls } = stub();
    await client(fetch).hello({
      currentOperatorSiteProcessId: 'PROC-1',
      currentVatProcessId: 'VAT-1',
      currentAeBlockUnblockStateProcessId: 'AE-1',
    });
    const req = parseDocument(calls[0]!.body).value as {
      currentVatProcessId: string;
      currentAeBlockUnblockStateProcessId: string;
    };
    expect(req.currentVatProcessId).toBe('VAT-1');
    expect(req.currentAeBlockUnblockStateProcessId).toBe('AE-1');
  });

  it('honours an endpoints override', async () => {
    const { fetch, calls } = stub();
    const c = new ReceiptClient({
      apNumber: 'AP1',
      transport: { fetch },
      endpoints: { hello: 'https://override.example/hello' },
    });
    await c.hello({ currentOperatorSiteProcessId: 'P' });
    expect(calls[0]!.url).toBe('https://override.example/hello');
  });

  it('sends Hello to the hello endpoint with the AP number', async () => {
    const { fetch, calls } = stub();
    await client(fetch).hello({ currentOperatorSiteProcessId: 'PROC-1' });

    expect(calls[0]!.url).toBe('https://data.example/eReceiptMgmt/v1/hello');
    const req = parseDocument(calls[0]!.body).value as {
      APNumber: string;
      currentOperatorSiteProcessId: string;
    };
    expect(req.APNumber).toBe('AP12345678');
    expect(req.currentOperatorSiteProcessId).toBe('PROC-1');
  });

  it('queries a taxpayer by tax number', async () => {
    const { fetch, calls } = stub();
    await client(fetch).queryTaxpayer('12345678');

    expect(calls[0]!.url).toBe('https://data.example/eReceiptMgmt/v1/queryTaxpayer');
    const req = parseDocument(calls[0]!.body).value as { APNumber: string; taxNumber: string };
    expect(req.APNumber).toBe('AP12345678');
    expect(req.taxNumber).toBe('12345678');
  });

  it('looks up a product by code', async () => {
    const { fetch, calls } = stub();
    await client(fetch).getProductByCode('01012100');

    expect(calls[0]!.url).toBe('https://data.example/eReceiptMgmt/v1/getProductByCode');
    const req = parseDocument(calls[0]!.body).value as { productCode: string };
    expect(req.productCode).toBe('01012100');
  });

  it('requires a client certificate when no custom fetch is supplied', async () => {
    const bare = new ReceiptClient({ apNumber: 'AP1', baseUrl: 'https://data.example' });
    await expect(bare.hello({ currentOperatorSiteProcessId: 'P' })).rejects.toThrow(
      /client certificate/,
    );
  });
});
