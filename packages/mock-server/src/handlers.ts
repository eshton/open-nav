import { randomBytes, createCipheriv } from 'node:crypto';
import {
  HEADER_VERSION,
  REQUEST_VERSION,
  decodeInvoiceData,
  decodeToXml,
  passwordHash,
  requestSignature,
  serializeDocument,
  validateInvoice,
  type InvoiceData,
  type InvoiceStatusType,
  type SoftwareType,
} from '@open-nav/core';
import type { MockState, StoredInvoice } from './state.js';

/** Credentials the mock expects, mirroring a technical user. */
export interface MockCredentials {
  login: string;
  password: string;
  signKey: string;
  exchangeKey: string;
  taxNumber: string;
}

export interface HandlerConfig {
  credentials: MockCredentials;
  /**
   * Polls before a transaction reaches a terminal state.
   *
   * Zero means the verdict is available immediately, which is what most tests
   * want. A higher number exercises the caller's polling loop.
   */
  pollsBeforeDone: number;
  /**
   * Run the invoices through the validator and abort the invalid ones.
   *
   * On by default, so the mock rejects exactly what the library predicts NAV
   * would reject. A test that submits a bad invoice sees it aborted.
   */
  validate: boolean;
  /** Current time, injectable for deterministic tests. */
  now: () => Date;
}

export interface RequestContext {
  operation: string;
  body: string;
  document: { root: string; value: Record<string, unknown> };
}

export interface HandlerResult {
  status: number;
  body: string;
}

const SOFTWARE: SoftwareType = {
  softwareId: 'OPENNAVMOCK000001',
  softwareName: 'open-nav mock server',
  softwareOperation: 'LOCAL_SOFTWARE',
  softwareMainVersion: '0.1.0',
  softwareDevName: 'open-nav',
  softwareDevContact: 'https://github.com/eshton/open-nav',
};

/** A NAV interface error code the mock can return. */
type InterfaceError =
  | 'INVALID_REQUEST'
  | 'INVALID_SECURITY_USER'
  | 'INVALID_SIGNATURE'
  | 'INVALID_REQUEST_ID'
  | 'INVALID_EXCHANGE_TOKEN'
  | 'OPERATION_FAILED';

export class MockError extends Error {
  constructor(
    readonly errorCode: InterfaceError,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

function timestamp(config: HandlerConfig): string {
  return config.now().toISOString();
}

function header(config: HandlerConfig) {
  return {
    requestId: `MOCK${config.now().getTime().toString(36).toUpperCase()}`,
    timestamp: timestamp(config),
    requestVersion: REQUEST_VERSION,
    headerVersion: HEADER_VERSION,
  };
}

function ok(config: HandlerConfig) {
  return { header: header(config), result: { funcCode: 'OK' }, software: SOFTWARE };
}

export function errorResponse(config: HandlerConfig, errorCode: string, message: string): string {
  return serializeDocument('GeneralErrorResponse', {
    header: header(config),
    result: { funcCode: 'ERROR', errorCode, message },
    software: SOFTWARE,
    technicalValidationMessages: [
      { validationResultCode: 'ERROR', validationErrorCode: errorCode, message },
    ],
  });
}

/**
 * Verify the request the way NAV does.
 *
 * This is the reason a mock is worth having: it recomputes the signature from
 * the request's own fields and the expected sign key, so a caller that builds
 * the signature wrongly finds out here rather than against the live service,
 * where the only clue is an opaque INVALID_SIGNATURE.
 */
export function authenticate(
  context: RequestContext,
  config: HandlerConfig,
  state: MockState,
  signedOperations: Array<{ index: number; operation: string; base64Payload: string }> = [],
): void {
  const value = context.document.value as {
    header?: { requestId?: string; timestamp?: string; requestVersion?: string };
    user?: {
      login?: string;
      passwordHash?: { value?: string; cryptoType?: string };
      taxNumber?: string;
      requestSignature?: { value?: string; cryptoType?: string };
    };
    software?: unknown;
  };

  const requestId = value.header?.requestId;
  const stamp = value.header?.timestamp;
  if (!requestId || !stamp) {
    throw new MockError('INVALID_REQUEST', 'header/requestId and header/timestamp are required');
  }
  if (value.header?.requestVersion !== REQUEST_VERSION) {
    throw new MockError(
      'INVALID_REQUEST',
      `requestVersion must be ${REQUEST_VERSION}, got ${value.header?.requestVersion}`,
    );
  }
  if (!value.software) {
    throw new MockError('INVALID_REQUEST', 'the software block is required on every request');
  }

  // NAV rejects a replayed requestId, and so does this.
  if (state.requestIds.has(requestId)) {
    throw new MockError('INVALID_REQUEST_ID', `requestId ${requestId} has already been used`);
  }
  state.requestIds.add(requestId);

  const user = value.user;
  if (user?.login !== config.credentials.login) {
    throw new MockError('INVALID_SECURITY_USER', 'unknown technical user');
  }
  if (user.passwordHash?.value !== passwordHash(config.credentials.password)) {
    throw new MockError('INVALID_SECURITY_USER', 'password hash does not match');
  }
  if (user.passwordHash?.cryptoType !== 'SHA-512') {
    throw new MockError('INVALID_SECURITY_USER', 'passwordHash cryptoType must be SHA-512');
  }
  if (user.taxNumber !== config.credentials.taxNumber) {
    throw new MockError('INVALID_SECURITY_USER', 'taxNumber does not match the technical user');
  }

  const expected = requestSignature(requestId, stamp, config.credentials.signKey, signedOperations);
  if (user.requestSignature?.value !== expected) {
    throw new MockError(
      'INVALID_SIGNATURE',
      signedOperations.length > 0
        ? `requestSignature does not match; expected the SHA3-512 of requestId + timestamp + signKey + ${signedOperations.length} operation hash(es) in index order`
        : 'requestSignature does not match the SHA3-512 of requestId + timestamp + signKey',
    );
  }
  if (user.requestSignature?.cryptoType !== 'SHA3-512') {
    throw new MockError('INVALID_SIGNATURE', 'requestSignature cryptoType must be SHA3-512');
  }
}

export function handleTokenExchange(
  context: RequestContext,
  config: HandlerConfig,
  state: MockState,
): HandlerResult {
  authenticate(context, config, state);

  // A 16 character token, encrypted the way NAV encrypts it.
  const token = randomBytes(8).toString('hex').toUpperCase();
  state.tokens.set(token, { issuedAt: config.now().getTime(), spent: false });

  const cipher = createCipheriv(
    'aes-128-ecb',
    Buffer.from(config.credentials.exchangeKey, 'utf8'),
    null,
  );
  cipher.setAutoPadding(false);
  const encoded = Buffer.concat([
    cipher.update(Buffer.from(token, 'utf8')),
    cipher.final(),
  ]).toString('base64');

  const validFrom = config.now();
  const validTo = new Date(validFrom.getTime() + 5 * 60_000);

  return {
    status: 200,
    body: serializeDocument('TokenExchangeResponse', {
      ...ok(config),
      encodedExchangeToken: encoded,
      tokenValidityFrom: validFrom.toISOString(),
      tokenValidityTo: validTo.toISOString(),
    }),
  };
}

interface OperationEntry {
  index: number;
  operation: string;
  base64: string;
}

function readInvoiceOperations(context: RequestContext): {
  compressed: boolean;
  entries: OperationEntry[];
} {
  const value = context.document.value as {
    invoiceOperations?: {
      compressedContent?: boolean;
      invoiceOperation?: Array<{ index: number; invoiceOperation: string; invoiceData: string }>;
    };
  };
  const list = value.invoiceOperations?.invoiceOperation ?? [];
  if (list.length === 0) {
    throw new MockError('INVALID_REQUEST', 'invoiceOperations must contain at least one operation');
  }
  return {
    compressed: value.invoiceOperations?.compressedContent === true,
    entries: list.map((entry) => ({
      index: entry.index,
      operation: entry.invoiceOperation,
      base64: entry.invoiceData,
    })),
  };
}

function consumeToken(context: RequestContext, state: MockState): void {
  const token = (context.document.value as { exchangeToken?: string }).exchangeToken;
  if (!token) throw new MockError('INVALID_EXCHANGE_TOKEN', 'exchangeToken is required');
  const record = state.tokens.get(token);
  if (!record) throw new MockError('INVALID_EXCHANGE_TOKEN', 'unknown exchange token');
  if (record.spent) {
    throw new MockError('INVALID_EXCHANGE_TOKEN', 'this exchange token has already been used');
  }
  record.spent = true;
}

export function handleManageInvoice(
  context: RequestContext,
  config: HandlerConfig,
  state: MockState,
): HandlerResult {
  const { compressed, entries } = readInvoiceOperations(context);

  authenticate(
    context,
    config,
    state,
    entries.map((entry) => ({
      index: entry.index,
      operation: entry.operation,
      base64Payload: entry.base64,
    })),
  );
  consumeToken(context, state);

  const transactionId = `MOCKTX${(state.transactions.size + 1).toString().padStart(6, '0')}`;
  const insDate = timestamp(config);
  const results: Array<{
    index: number;
    invoiceStatus: InvoiceStatusType;
    businessValidationMessages: Array<{
      validationResultCode: 'ERROR' | 'WARN' | 'INFO';
      validationErrorCode?: string;
      message?: string;
    }>;
  }> = [];

  for (const entry of entries) {
    let invoice: InvoiceData;
    try {
      invoice = decodeInvoiceData(entry.base64, { compressed });
    } catch (cause) {
      results.push({
        index: entry.index,
        invoiceStatus: 'ABORTED',
        businessValidationMessages: [
          {
            validationResultCode: 'ERROR',
            validationErrorCode: 'SCHEMA_VIOLATION',
            message: `invoiceData could not be read: ${(cause as Error).message}`,
          },
        ],
      });
      continue;
    }

    // The mock rejects what the validator predicts NAV would reject, so a
    // test that submits a broken invoice sees a realistic ABORTED result.
    const report = config.validate
      ? validateInvoice(invoice, {
          operation: entry.operation as 'CREATE',
          supplierTaxNumber: config.credentials.taxNumber,
        })
      : { valid: true, errors: [], warnings: [], issues: [] };

    if (!report.valid) {
      results.push({
        index: entry.index,
        invoiceStatus: 'ABORTED',
        businessValidationMessages: report.errors.map((issue) => ({
          validationResultCode: 'ERROR' as const,
          validationErrorCode: issue.code,
          message: `${issue.path}: ${issue.message}`,
        })),
      });
      continue;
    }

    const head = invoice.invoiceMain.invoice?.invoiceHead;
    const stored: StoredInvoice = {
      invoiceNumber: invoice.invoiceNumber,
      operation: entry.operation,
      supplierTaxNumber: head?.supplierInfo.supplierTaxNumber.taxpayerId ?? '',
      ...(head?.customerInfo?.customerVatData?.customerTaxNumber?.taxpayerId
        ? { customerTaxNumber: head.customerInfo.customerVatData.customerTaxNumber.taxpayerId }
        : {}),
      issueDate: invoice.invoiceIssueDate,
      base64: entry.base64,
      compressed,
      invoice,
      transactionId,
      index: entry.index,
      insDate,
    };
    state.invoices.set(invoice.invoiceNumber, stored);

    results.push({
      index: entry.index,
      invoiceStatus: 'DONE',
      businessValidationMessages: report.warnings.map((issue) => ({
        validationResultCode: 'WARN' as const,
        validationErrorCode: issue.code,
        message: `${issue.path}: ${issue.message}`,
      })),
    });
  }

  state.transactions.set(transactionId, {
    transactionId,
    insDate,
    polls: 0,
    results,
    finalStatuses: results.map((result) => result.invoiceStatus),
  });

  return {
    status: 200,
    body: serializeDocument('ManageInvoiceResponse', { ...ok(config), transactionId }),
  };
}

export function handleQueryTransactionStatus(
  context: RequestContext,
  config: HandlerConfig,
  state: MockState,
): HandlerResult {
  authenticate(context, config, state);
  const transactionId = (context.document.value as { transactionId?: string }).transactionId;
  if (!transactionId) throw new MockError('INVALID_REQUEST', 'transactionId is required');

  const transaction = state.transactions.get(transactionId);
  if (!transaction) {
    // NAV answers an unknown transaction with an empty result, not an error.
    return {
      status: 200,
      body: serializeDocument('QueryTransactionStatusResponse', { ...ok(config) }),
    };
  }

  transaction.polls += 1;
  const settled = transaction.polls > config.pollsBeforeDone;

  return {
    status: 200,
    body: serializeDocument('QueryTransactionStatusResponse', {
      ...ok(config),
      processingResults: {
        processingResult: transaction.results.map((result, position) => ({
          index: result.index,
          invoiceStatus: settled
            ? (transaction.finalStatuses[position] ?? 'DONE')
            : transaction.polls === 1
              ? 'RECEIVED'
              : 'PROCESSING',
          compressedContentIndicator: false,
          ...(settled && result.businessValidationMessages.length > 0
            ? { businessValidationMessages: result.businessValidationMessages }
            : {}),
        })),
        originalRequestVersion: REQUEST_VERSION,
      },
    }),
  };
}

export function handleQueryTaxpayer(
  context: RequestContext,
  config: HandlerConfig,
  state: MockState,
): HandlerResult {
  authenticate(context, config, state);
  const taxNumber = (context.document.value as { taxNumber?: string }).taxNumber;
  if (!taxNumber) throw new MockError('INVALID_REQUEST', 'taxNumber is required');

  const taxpayer = state.taxpayers.get(taxNumber);
  return {
    status: 200,
    body: serializeDocument('QueryTaxpayerResponse', {
      ...ok(config),
      infoDate: timestamp(config),
      taxpayerValidity: taxpayer?.valid ?? false,
      ...(taxpayer
        ? {
            taxpayerData: {
              taxpayerName: taxpayer.name,
              ...(taxpayer.shortName ? { taxpayerShortName: taxpayer.shortName } : {}),
              taxNumberDetail: {
                taxpayerId: taxpayer.taxNumber,
                ...(taxpayer.vatCode ? { vatCode: taxpayer.vatCode } : {}),
                ...(taxpayer.countyCode ? { countyCode: taxpayer.countyCode } : {}),
              },
              incorporation: 'OTHER',
            },
          }
        : {}),
    }),
  };
}

export function handleQueryInvoiceCheck(
  context: RequestContext,
  config: HandlerConfig,
  state: MockState,
): HandlerResult {
  authenticate(context, config, state);
  const query = (
    context.document.value as {
      invoiceNumberQuery?: { invoiceNumber?: string; invoiceDirection?: string };
    }
  ).invoiceNumberQuery;
  const store = query?.invoiceDirection === 'INBOUND' ? state.inbound : state.invoices;
  return {
    status: 200,
    body: serializeDocument('QueryInvoiceCheckResponse', {
      ...ok(config),
      invoiceCheckResult: store.has(query?.invoiceNumber ?? ''),
    }),
  };
}

export function handleQueryInvoiceData(
  context: RequestContext,
  config: HandlerConfig,
  state: MockState,
): HandlerResult {
  authenticate(context, config, state);
  const query = (
    context.document.value as {
      invoiceNumberQuery?: {
        invoiceNumber?: string;
        invoiceDirection?: string;
        supplierTaxNumber?: string;
      };
    }
  ).invoiceNumberQuery;

  const inbound = query?.invoiceDirection === 'INBOUND';

  // NAV only accepts a supplier tax number when querying as the customer.
  if (!inbound && query?.supplierTaxNumber !== undefined) {
    throw new MockError(
      'INVALID_REQUEST',
      'BAD_QUERY_PARAM_SUPPLIER_NOT_EXPECTED: the supplier tax number is only usable when querying as customer',
    );
  }

  const store = inbound ? state.inbound : state.invoices;
  const stored = store.get(query?.invoiceNumber ?? '');

  if (!stored) {
    return { status: 200, body: serializeDocument('QueryInvoiceDataResponse', { ...ok(config) }) };
  }

  return {
    status: 200,
    body: serializeDocument('QueryInvoiceDataResponse', {
      ...ok(config),
      invoiceDataResult: {
        invoiceData: stored.base64,
        auditData: {
          insdate: stored.insDate,
          insCusUser: config.credentials.login,
          source: 'MGM',
          transactionId: stored.transactionId,
          index: stored.index,
          originalRequestVersion: REQUEST_VERSION,
        },
        compressedContentIndicator: stored.compressed,
      },
    }),
  };
}

export function handleQueryInvoiceDigest(
  context: RequestContext,
  config: HandlerConfig,
  state: MockState,
): HandlerResult {
  authenticate(context, config, state);
  const value = context.document.value as {
    page?: number;
    invoiceDirection?: string;
    invoiceQueryParams?: {
      mandatoryQueryParams?: { invoiceIssueDate?: { dateFrom?: string; dateTo?: string } };
    };
  };
  const range = value.invoiceQueryParams?.mandatoryQueryParams?.invoiceIssueDate;

  // NAV rejects a window wider than 35 days, so the mock does too: that is
  // what proves a caller splits its range instead of asking for a year.
  if (range?.dateFrom && range?.dateTo) {
    const days =
      (Date.parse(`${range.dateTo}T00:00:00Z`) - Date.parse(`${range.dateFrom}T00:00:00Z`)) /
      86_400_000;
    if (days > 34) {
      throw new MockError(
        'INVALID_REQUEST',
        'BAD_QUERY_PARAM_RANGE_EXCEEDED: date interval defined by the query parameters must not exceed 35 days',
      );
    }
  }

  const store = value.invoiceDirection === 'INBOUND' ? state.inbound : state.invoices;
  const matching = [...store.values()].filter((invoice) => {
    if (range?.dateFrom && invoice.issueDate < range.dateFrom) return false;
    if (range?.dateTo && invoice.issueDate > range.dateTo) return false;
    return true;
  });

  const pageSize = 100;
  const page = value.page ?? 1;
  const slice = matching.slice((page - 1) * pageSize, page * pageSize);

  return {
    status: 200,
    body: serializeDocument('QueryInvoiceDigestResponse', {
      ...ok(config),
      invoiceDigestResult: {
        currentPage: page,
        availablePage: Math.max(1, Math.ceil(matching.length / pageSize)),
        ...(slice.length > 0
          ? {
              invoiceDigest: slice.map((invoice) => ({
                invoiceNumber: invoice.invoiceNumber,
                invoiceOperation: invoice.operation,
                invoiceCategory:
                  invoice.invoice.invoiceMain.invoice?.invoiceHead.invoiceDetail.invoiceCategory ??
                  'NORMAL',
                invoiceIssueDate: invoice.issueDate,
                supplierTaxNumber: invoice.supplierTaxNumber,
                supplierName:
                  invoice.invoice.invoiceMain.invoice?.invoiceHead.supplierInfo.supplierName ?? '',
                ...(invoice.customerTaxNumber
                  ? { customerTaxNumber: invoice.customerTaxNumber }
                  : {}),
                transactionId: invoice.transactionId,
                index: invoice.index,
                insDate: invoice.insDate,
                ...digestAmounts(invoice.invoice),
              })),
            }
          : {}),
      },
    }),
  };
}

/**
 * The amount fields a digest carries.
 *
 * NAV's digest summarises an invoice, so a caller can decide what to fetch in
 * full without downloading everything. Populating them keeps the mock useful
 * for exercising code that reads a digest.
 */
function digestAmounts(document: InvoiceData): Record<string, string> {
  const invoice = document.invoiceMain.invoice;
  const summary = invoice?.invoiceSummary.summaryNormal;
  const currency = invoice?.invoiceHead.invoiceDetail.currencyCode;
  return {
    ...(currency ? { currency } : {}),
    ...(summary
      ? {
          invoiceNetAmount: summary.invoiceNetAmount,
          invoiceNetAmountHUF: summary.invoiceNetAmountHUF,
          invoiceVatAmount: summary.invoiceVatAmount,
          invoiceVatAmountHUF: summary.invoiceVatAmountHUF,
        }
      : {}),
  };
}

export function handleQueryTransactionList(
  context: RequestContext,
  config: HandlerConfig,
  state: MockState,
): HandlerResult {
  authenticate(context, config, state);
  const page = (context.document.value as { page?: number }).page ?? 1;
  const all = [...state.transactions.values()];

  return {
    status: 200,
    body: serializeDocument('QueryTransactionListResponse', {
      ...ok(config),
      transactionListResult: {
        currentPage: page,
        availablePage: 1,
        ...(all.length > 0
          ? {
              transaction: all.map((transaction) => ({
                insDate: transaction.insDate,
                insCusUser: config.credentials.login,
                source: 'MGM',
                transactionId: transaction.transactionId,
                requestStatus: 'DONE',
                technicalAnnulment: false,
                originalRequestVersion: REQUEST_VERSION,
                itemCount: transaction.results.length,
              })),
            }
          : {}),
      },
    }),
  };
}

export function handleManageAnnulment(
  context: RequestContext,
  config: HandlerConfig,
  state: MockState,
): HandlerResult {
  const value = context.document.value as {
    annulmentOperations?: {
      annulmentOperation?: Array<{
        index: number;
        annulmentOperation: string;
        invoiceAnnulment: string;
      }>;
    };
  };
  const entries = value.annulmentOperations?.annulmentOperation ?? [];
  if (entries.length === 0) {
    throw new MockError(
      'INVALID_REQUEST',
      'annulmentOperations must contain at least one operation',
    );
  }

  authenticate(
    context,
    config,
    state,
    entries.map((entry) => ({
      index: entry.index,
      operation: entry.annulmentOperation,
      base64Payload: entry.invoiceAnnulment,
    })),
  );
  consumeToken(context, state);

  // Confirm the payload is readable, the way the service would.
  for (const entry of entries) decodeToXml(entry.invoiceAnnulment);

  const transactionId = `MOCKAN${(state.transactions.size + 1).toString().padStart(6, '0')}`;
  state.transactions.set(transactionId, {
    transactionId,
    insDate: timestamp(config),
    polls: 0,
    results: entries.map((entry) => ({
      index: entry.index,
      invoiceStatus: 'DONE' as InvoiceStatusType,
      businessValidationMessages: [],
    })),
    finalStatuses: entries.map(() => 'DONE' as InvoiceStatusType),
  });

  return {
    status: 200,
    body: serializeDocument('ManageAnnulmentResponse', { ...ok(config), transactionId }),
  };
}

export const HANDLERS: Record<
  string,
  (context: RequestContext, config: HandlerConfig, state: MockState) => HandlerResult
> = {
  tokenExchange: handleTokenExchange,
  manageInvoice: handleManageInvoice,
  manageAnnulment: handleManageAnnulment,
  queryTransactionStatus: handleQueryTransactionStatus,
  queryTransactionList: handleQueryTransactionList,
  queryInvoiceData: handleQueryInvoiceData,
  queryInvoiceDigest: handleQueryInvoiceDigest,
  queryInvoiceCheck: handleQueryInvoiceCheck,
  queryTaxpayer: handleQueryTaxpayer,
};
