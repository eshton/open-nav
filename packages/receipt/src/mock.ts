import { parseDocument, serializeDocument } from './codec.js';

/**
 * A credential-free, in-process stand-in for the eNyugta M2M services.
 *
 * It returns a `fetch` to hand to {@link ReceiptRegistrationClient} and
 * {@link ReceiptClient} via `transport.fetch`, so a whole integration —
 * register → download certificate → Hello → CashRegisterInfo → submit
 * document/report — runs without any certificate or live NAV access.
 *
 * A fetch-level mock (rather than a real mutual-TLS server) is deliberate: the
 * data services authenticate with a client certificate at the TLS layer, which
 * a stub `fetch` sidesteps entirely, and it plugs straight into the client's
 * injectable fetch. Document/report submissions are checked for a well-formed
 * signed envelope (`envelopeHash`, `envelopeSignature`, `decryptKey`).
 *
 * @see ONAV-42.
 */
export interface ReceiptMockOptions {
  /** PEM certificate returned for a certificate-download GET. */
  certificatePem?: string;
  /** Set `callbackRequired` on the responses that carry it. Defaults to false. */
  callbackRequired?: boolean;
}

export interface ReceiptMockState {
  requests: Array<{ operation: string; method: string; body: string }>;
}

export interface ReceiptMock {
  fetch: typeof globalThis.fetch;
  state: ReceiptMockState;
}

const OK_HEADER = {
  requestId: 'MOCK',
  timestamp: '2026-01-01T00:00:00.000Z',
  requestVersion: '1.0',
};

const MOCK_CERT_PEM = '-----BEGIN CERTIFICATE-----\nMOCK\n-----END CERTIFICATE-----';

interface MockRequest {
  APNumber?: string;
  taxNumber?: string;
  decryptKey?: string;
  documentEnvelope?: SignedEnvelope;
  reportEnvelope?: SignedEnvelope;
}

interface SignedEnvelope {
  envelopeData?: string;
  envelopeHash?: { value?: string };
  envelopeSignature?: string;
}

/** Build an in-process eNyugta mock. */
export function createReceiptMock(options: ReceiptMockOptions = {}): ReceiptMock {
  const state: ReceiptMockState = { requests: [] };
  const callbackRequired = options.callbackRequired ?? false;

  const fetch = (async (url: string | URL, init: RequestInit = {}) => {
    const method = (init.method ?? 'GET').toUpperCase();
    const operation = String(url).split('?')[0]!.split('/').filter(Boolean).pop() ?? '';

    // Certificate download is a plain GET to a NAV-issued endpoint URL.
    if (method === 'GET') {
      state.requests.push({ operation, method, body: '' });
      return new Response(options.certificatePem ?? MOCK_CERT_PEM, { status: 200 });
    }

    const body = typeof init.body === 'string' ? init.body : '';
    state.requests.push({ operation, method, body });
    const request = parseDocument(body, { unknownElements: 'ignore' }).value as MockRequest;
    const ap = request.APNumber ?? 'AP00000000';

    try {
      return xmlResponse(respond(operation, request, ap, callbackRequired));
    } catch (error) {
      return xmlResponse(errorEnvelope(operation, (error as Error).message));
    }
  }) as unknown as typeof globalThis.fetch;

  return { fetch, state };
}

function respond(
  operation: string,
  request: MockRequest,
  ap: string,
  callbackRequired: boolean,
): string {
  switch (operation) {
    case 'registration':
    case 'renewCertificate':
      // A full RegistrationResponse nests required vat/operatorSite trees; the
      // clients only read the result verdict, so return an OK envelope.
      return serializeDocument('GeneralErrorHeaderResponse', {
        header: OK_HEADER,
        result: { funcCode: 'OK' },
      });

    case 'hello':
      return serializeDocument('HelloResponse', {
        header: OK_HEADER,
        result: { funcCode: 'OK' },
        APNumber: ap,
        callbackRequired,
      });

    case 'cashRegisterInfo':
      return serializeDocument('CashRegisterInfoResponse', {
        header: OK_HEADER,
        result: { funcCode: 'OK' },
        APNumber: ap,
        callbackRequired,
      });

    case 'document':
      requireEnvelope(request.documentEnvelope, request.decryptKey);
      return serializeDocument('DocumentResponse', {
        header: OK_HEADER,
        result: { funcCode: 'OK' },
        APNumber: ap,
        callbackRequired,
        taxNumber: request.taxNumber ?? '00000000',
      });

    case 'report':
      requireEnvelope(request.reportEnvelope, request.decryptKey);
      return serializeDocument('ReportResponse', {
        header: OK_HEADER,
        result: { funcCode: 'OK' },
        APNumber: ap,
        callbackRequired,
        taxNumber: request.taxNumber ?? '00000000',
      });

    case 'queryTaxpayer':
      return serializeDocument('QueryTaxpayerResponse', {
        header: OK_HEADER,
        result: { funcCode: 'OK' },
        APNumber: ap,
        callbackRequired,
        taxpayerValidity: true,
      });

    case 'getProductByCode':
      return serializeDocument('GetProductByCodeResponse', {
        header: OK_HEADER,
        result: { funcCode: 'OK' },
        APNumber: ap,
        callbackRequired,
        numberOfProducts: 0,
        products: { productItem: [] },
      });

    default:
      throw new Error(`unknown operation ${operation}`);
  }
}

/** Reject a submission whose envelope is not a well-formed signed envelope. */
function requireEnvelope(
  envelope: SignedEnvelope | undefined,
  decryptKey: string | undefined,
): void {
  if (!envelope?.envelopeData || !envelope.envelopeSignature || !envelope.envelopeHash?.value) {
    throw new Error('INVALID_ENVELOPE');
  }
  if (!decryptKey) throw new Error('MISSING_DECRYPT_KEY');
}

function errorEnvelope(operation: string, errorCode: string): string {
  return serializeDocument('GeneralErrorHeaderResponse', {
    header: OK_HEADER,
    result: { funcCode: 'ERROR', errorCode, message: `${operation}: ${errorCode}` },
  });
}

function xmlResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'application/xml' } });
}
