import { createServer, type Server } from 'node:https';
import { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import forge from 'node-forge';
import { NavApiError, NavTransportError } from '@open-nav/core';
import { postReceiptXmlSecure } from '../src/transport.js';
import { serializeDocument } from '../src/codec.js';

/** A self-signed cert + key (PEM), for the local TLS server and the client. */
function selfSigned(commonName: string): { cert: string; key: string } {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + 86_400_000);
  const attrs = [{ name: 'commonName', value: commonName }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return {
    cert: forge.pki.certificateToPem(cert),
    key: forge.pki.privateKeyToPem(keys.privateKey),
  };
}

const okEnvelope = serializeDocument('GeneralErrorHeaderResponse', {
  header: { requestId: 'R', timestamp: '2026-01-01T00:00:00.000Z', requestVersion: '1.0' },
  result: { funcCode: 'OK' },
});
const errorEnvelope = serializeDocument('GeneralErrorHeaderResponse', {
  header: { requestId: 'R', timestamp: '2026-01-01T00:00:00.000Z', requestVersion: '1.0' },
  result: { funcCode: 'ERROR', errorCode: 'INVALID_REQUEST', message: 'nope' },
});

const server = selfSigned('localhost');
const client = selfSigned('AP12345678');
let httpServer: Server;
let base: string;
let mode: 'ok' | 'error' | 'hang' = 'ok';

beforeAll(async () => {
  httpServer = createServer(
    { key: server.key, cert: server.cert, requestCert: true, rejectUnauthorized: false },
    (req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        if (mode === 'hang') return; // never respond → client times out
        res.writeHead(200, { 'content-type': 'application/xml' });
        res.end(mode === 'error' ? errorEnvelope : okEnvelope);
      });
    },
  );
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  base = `https://localhost:${(httpServer.address() as AddressInfo).port}`;
});

afterAll(() => httpServer.close());

const cert = { cert: client.cert, key: client.key, ca: server.cert };

describe('postReceiptXmlSecure over mutual TLS', () => {
  it('presents the client certificate and parses an OK response', async () => {
    mode = 'ok';
    const res = await postReceiptXmlSecure(`${base}/document`, '<x/>', { clientCertificate: cert });
    expect((res.value as { result: { funcCode: string } }).result.funcCode).toBe('OK');
  });

  it('maps a NAV ERROR verdict to NavApiError', async () => {
    mode = 'error';
    await expect(
      postReceiptXmlSecure(`${base}/document`, '<x/>', { clientCertificate: cert }),
    ).rejects.toBeInstanceOf(NavApiError);
  });

  it('times out distinctly when the server never responds', async () => {
    mode = 'hang';
    await expect(
      postReceiptXmlSecure(`${base}/document`, '<x/>', { clientCertificate: cert, timeoutMs: 300 }),
    ).rejects.toThrow(/timed out/);
  });

  it('requires a client certificate', async () => {
    await expect(postReceiptXmlSecure(`${base}/document`, '<x/>')).rejects.toBeInstanceOf(
      NavTransportError,
    );
  });
});
