import { describe, expect, it } from 'vitest';
import { ReceiptRegistrationClient } from '../src/registration.js';
import { parseDocument, serializeDocument } from '../src/codec.js';
import type { SoftwareType } from '../src/generated/types.js';

const software: SoftwareType = {
  softwareId: '12345678SZAMLAL01',
  softwareName: 'open-nav receipt test',
  softwareOperation: 'LOCAL_SOFTWARE',
  softwareMainVersion: '0.1.0',
  softwareDevName: 'open-nav',
  softwareDevContact: 'dev@example.invalid',
  softwareDevCountryCode: 'HU',
  softwareDevTaxNumber: '12345678',
  softwareHash: 'ABC123',
  softwareLastUpdateTime: '2026-01-01T00:00:00Z',
};

function stub(responder: (url: string, body: string) => string) {
  const calls: Array<{ url: string; body: string }> = [];
  const fetch = (async (url: string | URL, init: RequestInit = {}) => {
    const body = typeof init.body === 'string' ? init.body : '';
    calls.push({ url: String(url), body });
    return new Response(responder(String(url), body), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

// A full RegistrationResponse nests several required objects (vat, operatorSite,
// …); this test exercises the *request* the client builds, so the mock returns
// a minimal OK envelope the transport accepts.
const okResponse = (): string =>
  serializeDocument('GeneralErrorHeaderResponse', {
    header: { requestId: 'R', timestamp: '2026-01-01T00:00:00.000Z', requestVersion: '1.0' },
    result: { funcCode: 'OK' },
  });

describe('ReceiptRegistrationClient', () => {
  it('registers, generating CSRs, and returns the cert endpoints', async () => {
    const { fetch, calls } = stub(() => okResponse());
    const client = new ReceiptRegistrationClient({
      software,
      baseUrl: 'https://fam.example',
      now: () => new Date('2026-05-15T10:00:00Z'),
      transport: { fetch },
    });

    const result = await client.register({
      apNumber: 'AP12345678',
      registrationNumber: 'INSTALL-CODE-1',
      imei: '350000000000001',
      imsi: '216300000000001',
    });

    expect(result.response).toBeDefined();
    expect(result.authentication?.csrPem).toContain('CERTIFICATE REQUEST');
    expect(result.signing?.privateKeyPem).toContain('PRIVATE KEY');
    expect(calls[0]!.url).toBe('https://fam.example/registration');

    // The request carried the AP number, install code and both CSRs as base64
    // DER (whitespace-free, so it round-trips through XML cleanly).
    const req = parseDocument(calls[0]!.body).value as {
      APNumber: string;
      registrationNumber: string;
      authenticationCertificateRequest: string;
      signingCertificateRequest: string;
    };
    expect(req.APNumber).toBe('AP12345678');
    expect(req.registrationNumber).toBe('INSTALL-CODE-1');
    expect(req.authenticationCertificateRequest).toBe(result.authentication!.csrDerBase64);
    expect(req.authenticationCertificateRequest).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(req.signingCertificateRequest).toBe(result.signing!.csrDerBase64);
  });

  it('downloads a certificate from an endpoint', async () => {
    const { fetch } = stub(() => 'unused');
    const withGet = (async (url: string | URL, init: RequestInit = {}) => {
      if (init.method === 'GET')
        return new Response('-----BEGIN CERTIFICATE-----\nMII...\n-----END CERTIFICATE-----');
      return fetch(url, init);
    }) as unknown as typeof globalThis.fetch;
    const client = new ReceiptRegistrationClient({ software, transport: { fetch: withGet } });
    const cert = await client.downloadCertificate('https://fam.example/cert/sign/1', 0);
    expect(cert).toContain('BEGIN CERTIFICATE');
  });
});
