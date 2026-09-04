import { createCipheriv } from 'node:crypto';
import { serializeDocument, type SoftwareType } from '@open-nav/core';
import type { NavCredentials } from '../src/credentials.js';

export const CREDENTIALS: NavCredentials = {
  login: 'testlogin123',
  password: 'Test-Password-1',
  signKey: 'ac-ac3a-7f661bff7d342N43CYX4U9FG',
  exchangeKey: '0123456789abcdef',
  taxNumber: '11111111',
};

export const SOFTWARE: SoftwareType = {
  softwareId: 'OPENNAV000000001',
  softwareName: 'open-nav test',
  softwareOperation: 'LOCAL_SOFTWARE',
  softwareMainVersion: '0.1.0',
  softwareDevName: 'open-nav contributors',
  softwareDevContact: 'dev@example.invalid',
  softwareDevCountryCode: 'HU',
  softwareDevTaxNumber: '11111111',
};

export const EXCHANGE_TOKEN = 'TOKEN0123456789A';

/** Encrypt a token the way NAV does, so the client has something real to decrypt. */
export function encodeExchangeToken(token: string, exchangeKey: string): string {
  const cipher = createCipheriv('aes-128-ecb', Buffer.from(exchangeKey, 'utf8'), null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(Buffer.from(token, 'utf8')), cipher.final()]).toString(
    'base64',
  );
}

function header() {
  return {
    requestId: 'RESPONSE0000001',
    timestamp: new Date('2026-03-01T10:00:00.000Z').toISOString(),
    requestVersion: '3.0',
    headerVersion: '1.0',
  };
}

const OK_RESULT = { funcCode: 'OK' } as const;

export function tokenExchangeResponse(exchangeKey = CREDENTIALS.exchangeKey): string {
  return serializeDocument('TokenExchangeResponse', {
    header: header(),
    result: OK_RESULT,
    software: SOFTWARE,
    encodedExchangeToken: encodeExchangeToken(EXCHANGE_TOKEN, exchangeKey),
    tokenValidityFrom: '2026-03-01T10:00:00.000Z',
    tokenValidityTo: '2026-03-01T10:05:00.000Z',
  });
}

export function manageInvoiceResponse(transactionId = 'TX0000000001'): string {
  return serializeDocument('ManageInvoiceResponse', {
    header: header(),
    result: OK_RESULT,
    software: SOFTWARE,
    transactionId,
  });
}

export interface StatusEntry {
  index: number;
  invoiceStatus: 'RECEIVED' | 'PROCESSING' | 'SAVED' | 'DONE' | 'ABORTED';
  businessValidationMessages?: Array<{
    validationResultCode: 'ERROR' | 'WARN' | 'INFO';
    validationErrorCode?: string;
    message?: string;
  }>;
}

export function transactionStatusResponse(entries: StatusEntry[]): string {
  return serializeDocument('QueryTransactionStatusResponse', {
    header: header(),
    result: OK_RESULT,
    software: SOFTWARE,
    processingResults: {
      processingResult: entries.map((entry) => ({
        index: entry.index,
        invoiceStatus: entry.invoiceStatus,
        compressedContentIndicator: false,
        ...(entry.businessValidationMessages
          ? { businessValidationMessages: entry.businessValidationMessages }
          : {}),
      })),
      originalRequestVersion: '3.0',
    },
  });
}

export function generalErrorResponse(errorCode: string, message: string): string {
  return serializeDocument('GeneralErrorResponse', {
    header: header(),
    result: { funcCode: 'ERROR', errorCode, message },
    software: SOFTWARE,
    technicalValidationMessages: [
      { validationResultCode: 'ERROR', validationErrorCode: errorCode, message },
    ],
  });
}

export interface RecordedRequest {
  url: string;
  body: string;
}

/** A fetch stub that records requests and replies from a scripted queue. */
export function stubFetch(
  handler: (url: string, body: string, call: number) => { status?: number; body: string },
): { fetch: typeof globalThis.fetch; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fetchStub = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = String(init?.body ?? '');
    requests.push({ url, body });
    const reply = handler(url, body, requests.length - 1);
    return new Response(reply.body, {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/xml' },
    });
  }) as unknown as typeof globalThis.fetch;
  return { fetch: fetchStub, requests };
}
