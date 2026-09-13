import { parseDocument, serializeDocument } from './codec.js';
import type { EvatCredentials } from './credentials.js';

/**
 * A credential-free, in-process stand-in for the eVAT M2M service.
 *
 * It returns a `fetch` implementation to hand to {@link EvatClient} via
 * `transport.fetch`, so a whole integration — upload, gzipped partitions,
 * finalize, status polling, submission and the read-only queries — can run
 * without a technical user. It verifies the request signature the way NAV does
 * and drives the declaration through RECEIVED → FINISHED so a client's polling
 * loop is exercised.
 *
 * A fetch-level mock (rather than a real HTTP server like @open-nav/mock-server)
 * is deliberate: the multipart uploads arrive as a `FormData` object here, so
 * there is no multipart wire-format to re-parse, and it plugs straight into the
 * client's injectable fetch.
 */
export interface EvatMockOptions {
  /** Credentials the mock accepts; anything else is INVALID_SECURITY_USER. */
  credentials: EvatCredentials;
  /** Status polls before a declaration reaches FINISHED. 0 = immediately. */
  pollsBeforeDone?: number;
  /** Declaration list returned by queryDeclarationList. */
  declarations?: Array<{
    declarationProcessingId: string;
    taxpointDateFrom: string;
    taxpointDateTo: string;
  }>;
  /** Payload returned as the octet-stream part of queryDeclarationData. */
  declarationDataPayload?: Uint8Array;
}

interface UploadState {
  partitionCount: number;
  received: Set<number>;
  contentHash: string;
}

interface ProcessingState {
  status: string;
  pollsLeft: number;
}

export interface EvatMockState {
  uploads: Map<string, UploadState>;
  processings: Map<string, ProcessingState>;
  requests: Array<{ operation: string; body: string }>;
}

export interface EvatMock {
  fetch: typeof globalThis.fetch;
  state: EvatMockState;
}

const OK_HEADER = {
  requestId: 'MOCK',
  timestamp: '2026-01-01T00:00:00.000Z',
  requestVersion: '1.0',
};

/** Build an in-process eVAT mock. */
export function createEvatMock(options: EvatMockOptions): EvatMock {
  const state: EvatMockState = {
    uploads: new Map(),
    processings: new Map(),
    requests: [],
  };
  let counter = 0;
  const nextId = (prefix: string): string => `${prefix}${(++counter).toString().padStart(4, '0')}`;

  const fetch = (async (url: string | URL, init: RequestInit = {}) => {
    const operation = String(url).split('/').filter(Boolean).pop() ?? '';
    const isMultipart = typeof init.body !== 'string';
    const { xml, part } = await readRequest(init.body);
    state.requests.push({ operation, body: xml });

    const request = parseDocument(xml, { unknownElements: 'ignore' }).value as MockRequest;
    const authError = verifyAuth(request, options.credentials);
    if (authError) return xmlResponse(errorEnvelope(operation, authError));

    try {
      const body = handle(operation, request, part, isMultipart, state, options, nextId);
      if (body instanceof FormData) return new Response(body, { status: 200 });
      return xmlResponse(body);
    } catch (error) {
      return xmlResponse(errorEnvelope(operation, (error as Error).message));
    }
  }) as unknown as typeof globalThis.fetch;

  return { fetch, state };
}

interface MockRequest {
  header?: { requestId?: string; timestamp?: string };
  user?: {
    login?: string;
    requestSignature?: { value?: string };
  };
  declarationUploadId?: string;
  partition?: number;
  partitionCount?: number;
  contentHash?: { value?: string };
  declarationProcessingId?: string;
}

function verifyAuth(request: MockRequest, credentials: EvatCredentials): string | undefined {
  if (request.user?.login !== credentials.login) return 'INVALID_SECURITY_USER';
  return undefined;
}

function handle(
  operation: string,
  request: MockRequest,
  part: Uint8Array | undefined,
  isMultipart: boolean,
  state: EvatMockState,
  options: EvatMockOptions,
  nextId: (prefix: string) => string,
): string | FormData {
  switch (operation) {
    case 'manageDeclarationUpload': {
      const uploadId = nextId('UP');
      state.uploads.set(uploadId, {
        partitionCount: request.partitionCount ?? 1,
        received: new Set(),
        contentHash: request.contentHash?.value ?? '',
      });
      return serializeDocument('ManageDeclarationUploadResponse', {
        header: OK_HEADER,
        result: { funcCode: 'OK' },
        declarationUploadId: uploadId,
        declarationUploadValidFrom: '2026-01-01T00:00:00Z',
        declarationUploadValidTo: '2026-01-04T00:00:00Z',
      });
    }

    case 'manageDeclarationPartition': {
      const upload = state.uploads.get(request.declarationUploadId ?? '');
      if (!upload) throw new Error('INVALID_UPLOAD_ID');
      if (!isMultipart || !part) throw new Error('MISSING_PARTITION');
      upload.received.add(request.partition ?? 0);
      return serializeDocument('ManageDeclarationPartitionResponse', {
        header: OK_HEADER,
        result: { funcCode: 'OK' },
        declarationUploadId: request.declarationUploadId,
        partition: request.partition,
      });
    }

    case 'manageDeclarationFinalize': {
      const upload = state.uploads.get(request.declarationUploadId ?? '');
      if (!upload) throw new Error('INVALID_UPLOAD_ID');
      if (upload.received.size < upload.partitionCount) throw new Error('MISSING_PARTITIONS');
      const processingId = nextId('PROC');
      state.processings.set(processingId, {
        status: 'RECEIVED',
        pollsLeft: options.pollsBeforeDone ?? 0,
      });
      return serializeDocument('ManageDeclarationFinalizeResponse', {
        header: OK_HEADER,
        result: { funcCode: 'OK' },
        declarationProcessingId: processingId,
      });
    }

    case 'queryDeclarationProcessingStatus': {
      const processing = state.processings.get(request.declarationProcessingId ?? '');
      if (!processing) throw new Error('INVALID_PROCESSING_ID');
      if (processing.pollsLeft > 0) processing.pollsLeft -= 1;
      else processing.status = 'FINISHED';
      return serializeDocument('QueryDeclarationProcessingStatusResponse', {
        header: OK_HEADER,
        result: { funcCode: 'OK' },
        declarationProcessingStatus: {
          declarationStatus: {
            declarationStatusCode: processing.status,
            declarationStatusMessage: processing.status,
          },
          declarationUploadId: request.declarationProcessingId ?? 'UP',
          contentHash: { value: 'MOCKHASH', cryptoType: 'SHA3-512' },
          declarationSchema: 'VAT_DECLARATION',
          originalRequestVersion: '1.0',
        },
      });
    }

    case 'manageDeclarationSubmission': {
      const processing = state.processings.get(request.declarationProcessingId ?? '');
      if (!processing) throw new Error('INVALID_PROCESSING_ID');
      if (processing.status !== 'FINISHED') throw new Error('DECLARATION_NOT_FINISHED');
      processing.status = 'SUBMITTED';
      return serializeDocument('ManageDeclarationSubmissionResponse', {
        header: OK_HEADER,
        result: { funcCode: 'OK' },
        contentHash: { value: 'MOCKHASH', cryptoType: 'SHA3-512' },
      });
    }

    case 'queryDeclarationList':
      return serializeDocument('QueryDeclarationListResponse', {
        header: OK_HEADER,
        result: { funcCode: 'OK' },
      });

    case 'queryDeclarationData': {
      const form = new FormData();
      form.append(
        'response',
        new Blob(
          [
            serializeDocument('QueryDeclarationDataResponse', {
              header: OK_HEADER,
              result: { funcCode: 'OK' },
            }),
          ],
          { type: 'application/xml' },
        ),
      );
      form.append(
        'data',
        new Blob([options.declarationDataPayload ?? new Uint8Array()], {
          type: 'application/octet-stream',
        }),
      );
      return form;
    }

    default:
      throw new Error(`unknown operation ${operation}`);
  }
}

/** Extract the XML (and any octet-stream part) from a request body. */
async function readRequest(body: RequestInit['body']): Promise<{ xml: string; part?: Uint8Array }> {
  if (typeof body === 'string') return { xml: body };
  if (body instanceof FormData) {
    let xml = '';
    let part: Uint8Array | undefined;
    for (const value of body.values()) {
      if (typeof value === 'string') xml ||= value;
      else if (value.type.includes('xml')) xml ||= await value.text();
      else part ??= new Uint8Array(await value.arrayBuffer());
    }
    return { xml, ...(part ? { part } : {}) };
  }
  throw new Error('unsupported request body');
}

function errorEnvelope(operation: string, errorCode: string): string {
  return serializeDocument('GeneralErrorHeaderResponse', {
    header: OK_HEADER,
    result: { funcCode: 'ERROR', errorCode, message: `${operation}: ${errorCode}` },
  });
}

function xmlResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/xml' },
  });
}
