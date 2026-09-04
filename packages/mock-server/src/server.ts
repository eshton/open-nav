import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { parseDocument } from '@open-nav/core';
import {
  HANDLERS,
  MockError,
  errorResponse,
  type HandlerConfig,
  type MockCredentials,
} from './handlers.js';
import { createState, type MockState, type MockTaxpayer } from './state.js';

export interface MockServerOptions {
  /** Credentials the mock accepts. Anything else is INVALID_SECURITY_USER. */
  credentials: MockCredentials;
  /** Taxpayers `queryTaxpayer` knows about. */
  taxpayers?: MockTaxpayer[];
  /** Port to listen on. 0, the default, picks a free one. */
  port?: number;
  host?: string;
  /** Polls before a transaction settles. 0 means immediately. */
  pollsBeforeDone?: number;
  /** Validate submitted invoices and abort the invalid ones. Default true. */
  validate?: boolean;
  /** Injectable clock. */
  now?: () => Date;
}

export interface MockServer {
  /** Base URL to hand to a `NavClient`, including the service path. */
  url: string;
  port: number;
  /** Everything the mock has recorded, for assertions. */
  state: MockState;
  close: () => Promise<void>;
  server: Server;
}

/**
 * Start a local stand-in for the Online Számla invoice service.
 *
 * It speaks the real XML on the real paths, verifies the request signature
 * the way NAV does, and decides an invoice's fate by running it through this
 * project's validator. That last part is what makes it useful: a test that
 * submits a broken invoice sees a realistic ABORTED result with the fault
 * code NAV would have reported.
 *
 * ```ts
 * const mock = await startMockServer({ credentials });
 * const client = new NavClient({ credentials, software, baseUrl: mock.url });
 * ```
 */
export async function startMockServer(options: MockServerOptions): Promise<MockServer> {
  const state = createState(options.taxpayers ?? []);
  const config: HandlerConfig = {
    credentials: options.credentials,
    pollsBeforeDone: options.pollsBeforeDone ?? 0,
    validate: options.validate ?? true,
    now: options.now ?? (() => new Date()),
  };

  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const { status, body: responseBody } = dispatch(
        request.method ?? '',
        request.url ?? '',
        body,
        config,
        state,
      );
      response.writeHead(status, { 'content-type': 'application/xml; charset=utf-8' });
      response.end(responseBody);
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', resolve);
  });

  const address = server.address() as AddressInfo;
  const host = options.host ?? '127.0.0.1';

  return {
    url: `http://${host}:${address.port}/invoiceService/v1`,
    port: address.port,
    state,
    server,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function dispatch(
  method: string,
  url: string,
  body: string,
  config: HandlerConfig,
  state: MockState,
): { status: number; body: string } {
  if (method !== 'POST') {
    return {
      status: 405,
      body: errorResponse(config, 'INVALID_REQUEST', 'only POST is supported'),
    };
  }

  const operation = url.split('?')[0]?.split('/').filter(Boolean).pop() ?? '';
  const handler = HANDLERS[operation];
  if (!handler) {
    return {
      status: 404,
      body: errorResponse(config, 'INVALID_REQUEST', `unknown operation ${operation}`),
    };
  }

  let document;
  try {
    // Lenient, because a caller's extra element should surface as a specific
    // complaint from a handler rather than as an opaque parse failure.
    document = parseDocument(body, { unknownElements: 'ignore' });
  } catch (cause) {
    return {
      status: 400,
      body: errorResponse(
        config,
        'INVALID_REQUEST',
        `request XML could not be parsed: ${(cause as Error).message}`,
      ),
    };
  }

  state.requests.push({
    operation,
    requestId: (document.value as { header?: { requestId?: string } }).header?.requestId ?? '',
    body,
  });

  try {
    return handler(
      {
        operation,
        body,
        document: { root: document.root, value: document.value as Record<string, unknown> },
      },
      config,
      state,
    );
  } catch (error) {
    if (error instanceof MockError) {
      return { status: error.status, body: errorResponse(config, error.errorCode, error.message) };
    }
    return {
      status: 500,
      body: errorResponse(config, 'OPERATION_FAILED', (error as Error).message),
    };
  }
}
