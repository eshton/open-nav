import {
  BASE_URLS,
  HEADER_VERSION,
  MAX_INVOICE_BATCH_SIZE,
  NavValidationError,
  PASSWORD_HASH_CRYPTO_TYPE,
  REQUEST_VERSION,
  SIGNATURE_CRYPTO_TYPE,
  createRequestId,
  decodeExchangeToken,
  encodeInvoiceAnnulment,
  encodeInvoiceData,
  passwordHash,
  requestSignature,
  serializeDocument,
  toHeaderTimestamp,
  type InvoiceAnnulment,
  type InvoiceData,
  type ManageAnnulmentRequest,
  type ManageAnnulmentResponse,
  type ManageInvoiceRequest,
  type ManageInvoiceResponse,
  type NavEnvironment,
  type QueryInvoiceChainDigestRequest,
  type QueryInvoiceChainDigestResponse,
  type QueryInvoiceCheckRequest,
  type QueryInvoiceCheckResponse,
  type QueryInvoiceDataRequest,
  type QueryInvoiceDataResponse,
  type QueryInvoiceDigestRequest,
  type QueryInvoiceDigestResponse,
  type QueryTaxpayerRequest,
  type QueryTaxpayerResponse,
  type QueryTransactionListRequest,
  type QueryTransactionListResponse,
  type QueryTransactionStatusRequest,
  type QueryTransactionStatusResponse,
  type SignedOperation,
  type SoftwareType,
  type TokenExchangeResponse,
  type ValidationIssue,
} from '@open-nav/core';
import { assertCredentials, type NavCredentials } from './credentials.js';
import { postXml, type TransportOptions } from './transport.js';

/**
 * A request body with the parts the client fills in removed.
 *
 * Deriving these from the generated request types means there is no
 * hand-maintained parameter list to fall out of step with the schema.
 */
export type RequestBody<T> = Omit<T, 'header' | 'user' | 'software'>;

/** A manage request body; the exchange token is obtained by the client. */
export type ManageBody<T> = Omit<RequestBody<T>, 'exchangeToken'>;

export interface NavClientOptions {
  credentials: NavCredentials;
  /**
   * Identification of the invoicing software, which NAV requires on every
   * request and uses for its own statistics and support.
   */
  software: SoftwareType;
  /** `test` (the default) or `production`. */
  environment?: NavEnvironment;
  /** Overrides `environment`; useful for a mock server. */
  baseUrl?: string;
  /** Prefix for generated request identifiers, for tracing. */
  requestIdPrefix?: string;
  /** Injectable clock, for deterministic tests. */
  now?: () => Date;
  transport?: TransportOptions;
}

export interface InvoiceOperationInput {
  /** `CREATE`, `MODIFY` or `STORNO`. */
  operation: 'CREATE' | 'MODIFY' | 'STORNO';
  /** The invoice, or an already base64 encoded payload. */
  invoice: InvoiceData | { base64: string };
}

export interface SubmitInvoicesOptions {
  /** Gzip each payload. The flag applies to the whole batch. */
  compress?: boolean;
}

/**
 * Client for the NAV Online Számla 3.0 invoice service.
 *
 * Every method corresponds to one service operation and takes the generated
 * request type minus the header, user and software blocks, which the client
 * builds and signs.
 *
 * ```ts
 * const client = new NavClient({ credentials, software, environment: 'test' });
 * const taxpayer = await client.queryTaxpayer({ taxNumber: '12345678' });
 * ```
 */
export class NavClient {
  private readonly baseUrl: string;
  private readonly credentials: NavCredentials;
  private readonly software: SoftwareType;
  private readonly requestIdPrefix: string | undefined;
  private readonly now: () => Date;
  private readonly transport: TransportOptions;

  constructor(options: NavClientOptions) {
    assertCredentials(options.credentials);
    this.credentials = options.credentials;
    this.software = options.software;
    this.baseUrl = options.baseUrl ?? BASE_URLS[options.environment ?? 'test'];
    this.requestIdPrefix = options.requestIdPrefix;
    this.now = options.now ?? (() => new Date());
    this.transport = options.transport ?? {};
  }

  /**
   * Exchange credentials for a single-use token required by the manage
   * operations.
   *
   * The token arrives AES-128-ECB encrypted under the exchange key and is
   * decrypted here. NAV keeps it valid for a few minutes; this client fetches
   * a fresh one per manage call rather than caching, because a token consumed
   * by a submission cannot be reused and a stale one fails opaquely.
   */
  async tokenExchange(): Promise<{
    token: string;
    validityFrom: string;
    validityTo: string;
    response: TokenExchangeResponse;
  }> {
    const response = await this.execute<TokenExchangeResponse>(
      'tokenExchange',
      'TokenExchangeRequest',
      {},
    );
    return {
      token: decodeExchangeToken(response.encodedExchangeToken, this.credentials.exchangeKey),
      validityFrom: response.tokenValidityFrom,
      validityTo: response.tokenValidityTo,
      response,
    };
  }

  /** Submit invoice data. Returns the transaction to poll for the outcome. */
  async manageInvoice(body: ManageBody<ManageInvoiceRequest>): Promise<ManageInvoiceResponse> {
    assertBatchSize(body.invoiceOperations.invoiceOperation.length, 'invoiceOperations');
    const { token } = await this.tokenExchange();
    const signed: SignedOperation[] = body.invoiceOperations.invoiceOperation.map((operation) => ({
      index: operation.index,
      operation: operation.invoiceOperation,
      base64Payload: operation.invoiceData,
    }));
    return this.execute<ManageInvoiceResponse>(
      'manageInvoice',
      'ManageInvoiceRequest',
      { ...body, exchangeToken: token },
      { signed, retryable: false },
    );
  }

  /** Technically annul a previously submitted, erroneous data report. */
  async manageAnnulment(
    body: ManageBody<ManageAnnulmentRequest>,
  ): Promise<ManageAnnulmentResponse> {
    assertBatchSize(body.annulmentOperations.annulmentOperation.length, 'annulmentOperations');
    const { token } = await this.tokenExchange();
    const signed: SignedOperation[] = body.annulmentOperations.annulmentOperation.map(
      (operation) => ({
        index: operation.index,
        operation: operation.annulmentOperation,
        base64Payload: operation.invoiceAnnulment,
      }),
    );
    return this.execute<ManageAnnulmentResponse>(
      'manageAnnulment',
      'ManageAnnulmentRequest',
      { ...body, exchangeToken: token },
      { signed, retryable: false },
    );
  }

  /** Processing state and validation messages of a submitted transaction. */
  queryTransactionStatus(
    body: RequestBody<QueryTransactionStatusRequest>,
  ): Promise<QueryTransactionStatusResponse> {
    return this.execute('queryTransactionStatus', 'QueryTransactionStatusRequest', body);
  }

  /** Transactions submitted in a time window, paged. */
  queryTransactionList(
    body: RequestBody<QueryTransactionListRequest>,
  ): Promise<QueryTransactionListResponse> {
    return this.execute('queryTransactionList', 'QueryTransactionListRequest', body);
  }

  /** Full invoice data of one invoice, inbound or outbound. */
  queryInvoiceData(body: RequestBody<QueryInvoiceDataRequest>): Promise<QueryInvoiceDataResponse> {
    return this.execute('queryInvoiceData', 'QueryInvoiceDataRequest', body);
  }

  /** Paged summary list of invoices matching a query. */
  queryInvoiceDigest(
    body: RequestBody<QueryInvoiceDigestRequest>,
  ): Promise<QueryInvoiceDigestResponse> {
    return this.execute('queryInvoiceDigest', 'QueryInvoiceDigestRequest', body);
  }

  /** Modification chain of an invoice. */
  queryInvoiceChainDigest(
    body: RequestBody<QueryInvoiceChainDigestRequest>,
  ): Promise<QueryInvoiceChainDigestResponse> {
    return this.execute('queryInvoiceChainDigest', 'QueryInvoiceChainDigestRequest', body);
  }

  /** Whether an invoice number exists in NAV's records. */
  queryInvoiceCheck(
    body: RequestBody<QueryInvoiceCheckRequest>,
  ): Promise<QueryInvoiceCheckResponse> {
    return this.execute('queryInvoiceCheck', 'QueryInvoiceCheckRequest', body);
  }

  /** Validity and registered data of a Hungarian taxpayer. */
  queryTaxpayer(body: RequestBody<QueryTaxpayerRequest>): Promise<QueryTaxpayerResponse> {
    return this.execute('queryTaxpayer', 'QueryTaxpayerRequest', body);
  }

  /**
   * Encode invoices and submit them as one batch.
   *
   * Encoding happens once and the same base64 is both sent and hashed, which
   * is the only safe way to do it: hashing a separately serialised copy of the
   * same invoice is a signature failure waiting to happen.
   */
  async submitInvoices(
    invoices: InvoiceOperationInput[],
    options: SubmitInvoicesOptions = {},
  ): Promise<ManageInvoiceResponse> {
    assertBatchSize(invoices.length, 'invoices');
    return this.manageInvoice({
      invoiceOperations: {
        compressedContent: options.compress ?? false,
        invoiceOperation: invoices.map((entry, position) => ({
          index: position + 1,
          invoiceOperation: entry.operation,
          invoiceData:
            'base64' in entry.invoice
              ? entry.invoice.base64
              : encodeInvoiceData(entry.invoice, { compress: options.compress }),
        })),
      },
    });
  }

  /** Annul one or more previously reported invoices. */
  async submitAnnulments(
    annulments: Array<InvoiceAnnulment | { base64: string }>,
    options: SubmitInvoicesOptions = {},
  ): Promise<ManageAnnulmentResponse> {
    assertBatchSize(annulments.length, 'annulments');
    return this.manageAnnulment({
      annulmentOperations: {
        annulmentOperation: annulments.map((entry, position) => ({
          index: position + 1,
          annulmentOperation: 'ANNUL',
          invoiceAnnulment:
            'base64' in entry
              ? entry.base64
              : encodeInvoiceAnnulment(entry, { compress: options.compress }),
        })),
      },
    });
  }

  /** Build, sign and send one request. */
  private async execute<TResponse>(
    operation: string,
    rootName: string,
    body: object,
    options: { signed?: SignedOperation[]; retryable?: boolean } = {},
  ): Promise<TResponse> {
    const requestId = createRequestId(this.requestIdPrefix);
    const timestamp = toHeaderTimestamp(this.now());

    const request = {
      header: {
        requestId,
        timestamp,
        requestVersion: REQUEST_VERSION,
        headerVersion: HEADER_VERSION,
      },
      user: {
        login: this.credentials.login,
        passwordHash: {
          value: passwordHash(this.credentials.password),
          cryptoType: PASSWORD_HASH_CRYPTO_TYPE,
        },
        taxNumber: this.credentials.taxNumber,
        requestSignature: {
          value: requestSignature(
            requestId,
            timestamp,
            this.credentials.signKey,
            options.signed ?? [],
          ),
          cryptoType: SIGNATURE_CRYPTO_TYPE,
        },
      },
      software: this.software,
      ...body,
    };

    const xml = serializeDocument(rootName, request);
    const response = await postXml(
      this.baseUrl,
      operation,
      xml,
      this.transport,
      options.retryable ?? true,
    );
    return response.value as TResponse;
  }
}

function assertBatchSize(size: number, path: string): void {
  const issues: ValidationIssue[] = [];
  if (size === 0) {
    issues.push({ path, code: 'EMPTY_BATCH', message: 'must contain at least one operation' });
  }
  if (size > MAX_INVOICE_BATCH_SIZE) {
    issues.push({
      path,
      code: 'BATCH_TOO_LARGE',
      message: `NAV accepts at most ${MAX_INVOICE_BATCH_SIZE} operations per request, got ${size}`,
    });
  }
  if (issues.length > 0) throw new NavValidationError('Invalid batch', issues);
}
