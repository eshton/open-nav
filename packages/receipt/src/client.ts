import { createRequestId, toHeaderTimestamp, trimTrailingSlash } from '@open-nav/core';
import { serializeDocument } from './codec.js';
import { buildDocumentEnvelope, buildReportEnvelope } from './envelope.js';
import {
  postReceiptXmlSecure,
  type ClientCertificate,
  type SecureTransportOptions,
} from './transport.js';
import type {
  CashRegisterInfoResponse,
  CashRegisterInfoType,
  DocumentClassType,
  DocumentResponse,
  GetProductByCodeResponse,
  HelloResponse,
  QueryTaxpayerResponse,
  ReportClassType,
  ReportResponse,
} from './generated/types.js';

/** Interface/header versions for the eNyugta data-service requests. */
export const RECEIPT_DATA_REQUEST_VERSION = '1.0';
export const RECEIPT_DATA_HEADER_VERSION = '1.0';

/**
 * Base URL (host only) for the authenticated data services of the **hardware**
 * e-cash register, over mutual TLS.
 *
 * Pinned from NAV's apidog collection: the test ("BV") secured host is
 * `navi-bv-sec.enyugta.nav.gov.hu`; production drops the `-bv` suffix (not yet
 * confirmed on the live system). The per-operation service path lives in
 * {@link DEFAULT_PATHS}, because NAV serves `document` under `eReceiptMgmt/v1`
 * but `report` under `eReceipt/v1`. Pass full URLs via
 * {@link ReceiptClientOptions.endpoints} to override.
 */
export const RECEIPT_DATA_BASE_URLS = {
  test: 'https://navi-bv-sec.enyugta.nav.gov.hu',
  production: 'https://navi-sec.enyugta.nav.gov.hu',
} as const;

type OperationKey =
  'hello' | 'cashRegisterInfo' | 'document' | 'report' | 'queryTaxpayer' | 'getProductByCode';

// Service path + operation, from NAV's apidog. document/report deliberately
// differ (eReceiptMgmt/v1 vs eReceipt/v1). queryTaxpayer / getProductByCode are
// not in the hardware apidog export — their paths here are best-effort, to be
// confirmed against the live system.
const DEFAULT_PATHS: Record<OperationKey, string> = {
  hello: 'eReceiptMgmt/v1/hello',
  cashRegisterInfo: 'eReceiptMgmt/v1/cashRegisterInfo',
  document: 'eReceiptMgmt/v1/document',
  report: 'eReceipt/v1/report',
  queryTaxpayer: 'eReceiptMgmt/v1/queryTaxpayer',
  getProductByCode: 'eReceiptMgmt/v1/getProductByCode',
};

export interface ReceiptClientOptions {
  /** The e-cash register AP number sent on every request. */
  apNumber: string;
  /**
   * The register's authentication certificate for mutual TLS. Optional only
   * when a custom transport `fetch` presents the certificate itself.
   */
  clientCertificate?: ClientCertificate;
  /** Base URL for the data services. */
  baseUrl?: string;
  /** Full per-operation URLs, overriding baseUrl + default path. */
  endpoints?: Partial<Record<OperationKey, string>>;
  now?: () => Date;
  requestIdPrefix?: string;
  transport?: SecureTransportOptions;
}

/** Common business fields carried by a document/report submission. */
export interface SubmissionHeader {
  /** First 8 characters of the issuing taxpayer's tax number. */
  taxNumber: string;
  /** First 8 characters of the VAT-group identifier, if any. */
  groupIdentificationNumber?: string;
  /** The single-use search key the document store is queried by. */
  searchKey: string;
  /** Document/report creation timestamp (the search-key timestamp). */
  searchKeyTimestamp: string;
  /** Envelope `recordCounter` and the previous one (NAV verification code). */
  recordCounter: number;
  lastRecordCounter: number;
  ntcaVerificationCode: string;
  /** Whether the QR code generation window had expired. */
  qRCodeExpired: boolean;
  /** Whether the document was created offline (delayed submission). */
  offlineCreated: boolean;
  /** The register's signing certificate, DER (base64), echoed on the request. */
  cashRegisterSignCertificate: string;
  /** Process id when submitting due to a SEND_MISSING_DOCUMENT command. */
  sendMissingDocumentProcessId?: string;
}

export interface DocumentSubmission extends SubmissionHeader {
  documentClass: DocumentClassType;
  /** Serialized `CoreDocument` XML (NAV + issuer data). */
  coreDocumentXml: string;
  /** Serialized `CustomerDocument` XML (customer copy). */
  customerDocumentXml: string;
  /** The register's signing key (PEM) — signs the envelope. */
  signingKeyPem: string;
}

export interface ReportSubmission extends SubmissionHeader {
  reportClass: ReportClassType;
  /** Serialized `CoreReport` XML. */
  coreReportXml: string;
  /** Serialized `CustomerReport` XML, if the report carries customer data. */
  customerReportXml?: string;
  signingKeyPem: string;
}

export interface HelloInput {
  currentOperatorSiteProcessId: string;
  currentVatProcessId?: string;
  currentAeBlockUnblockStateProcessId?: string;
}

/**
 * Client for the authenticated eNyugta data services: `Hello`,
 * `CashRegisterInfo`, and document/report submission. Requests go out over
 * mutual TLS with the register's authentication certificate; document/report
 * payloads are wrapped in a signed, encrypted envelope (see `envelope.ts`).
 *
 * @see ONAV-40 for the bootstrap (registration) client.
 */
export class ReceiptClient {
  private readonly apNumber: string;
  private readonly baseUrl: string;
  private readonly endpoints: Partial<Record<OperationKey, string>>;
  private readonly now: () => Date;
  private readonly requestIdPrefix: string | undefined;
  private readonly transport: SecureTransportOptions;

  constructor(options: ReceiptClientOptions) {
    this.apNumber = options.apNumber;
    this.baseUrl = options.baseUrl ?? RECEIPT_DATA_BASE_URLS.test;
    this.endpoints = options.endpoints ?? {};
    this.now = options.now ?? (() => new Date());
    this.requestIdPrefix = options.requestIdPrefix;
    this.transport = {
      ...options.transport,
      ...(options.clientCertificate ? { clientCertificate: options.clientCertificate } : {}),
    };
  }

  /** Handshake after registration/owner change; returns any pending commands. */
  async hello(input: HelloInput): Promise<HelloResponse> {
    const request = {
      ...this.header(),
      APNumber: this.apNumber,
      currentOperatorSiteProcessId: input.currentOperatorSiteProcessId,
      ...(input.currentVatProcessId ? { currentVatProcessId: input.currentVatProcessId } : {}),
      ...(input.currentAeBlockUnblockStateProcessId
        ? { currentAeBlockUnblockStateProcessId: input.currentAeBlockUnblockStateProcessId }
        : {}),
    };
    return this.send('hello', 'HelloRequest', request) as Promise<HelloResponse>;
  }

  /** Report register status/telemetry to NAV. */
  async cashRegisterInfo(
    cashRegisterInfo: CashRegisterInfoType,
  ): Promise<CashRegisterInfoResponse> {
    const request = { ...this.header(), APNumber: this.apNumber, cashRegisterInfo };
    return this.send(
      'cashRegisterInfo',
      'CashRegisterInfoRequest',
      request,
    ) as Promise<CashRegisterInfoResponse>;
  }

  /** Submit a receipt/invoice document (builds + signs the envelope). */
  async submitDocument(submission: DocumentSubmission): Promise<DocumentResponse> {
    const { envelope, decryptKey } = buildDocumentEnvelope(
      submission.coreDocumentXml,
      submission.customerDocumentXml,
      submission.signingKeyPem,
    );
    const request = {
      ...this.header(),
      APNumber: this.apNumber,
      taxNumber: submission.taxNumber,
      ...(submission.groupIdentificationNumber
        ? { groupIdentificationNumber: submission.groupIdentificationNumber }
        : {}),
      documentClass: submission.documentClass,
      documentEnvelope: envelope,
      decryptKey,
      searchKeyTimestamp: submission.searchKeyTimestamp,
      searchKey: submission.searchKey,
      qRCodeExpired: submission.qRCodeExpired,
      offlineCreated: submission.offlineCreated,
      cashRegisterSignCertificate: submission.cashRegisterSignCertificate,
      recordCounter: submission.recordCounter,
      lastRecordCounter: submission.lastRecordCounter,
      ntcaVerificationCode: submission.ntcaVerificationCode,
      ...(submission.sendMissingDocumentProcessId
        ? { sendMissingDocumentProcessId: submission.sendMissingDocumentProcessId }
        : {}),
    };
    return this.send('document', 'DocumentRequest', request) as Promise<DocumentResponse>;
  }

  /** Submit a report (cash-register report, cash-flow document, …). */
  async submitReport(submission: ReportSubmission): Promise<ReportResponse> {
    const { envelope, decryptKey } = buildReportEnvelope(
      submission.coreReportXml,
      submission.customerReportXml,
      submission.signingKeyPem,
    );
    const request = {
      ...this.header(),
      APNumber: this.apNumber,
      taxNumber: submission.taxNumber,
      ...(submission.groupIdentificationNumber
        ? { groupIdentificationNumber: submission.groupIdentificationNumber }
        : {}),
      reportClass: submission.reportClass,
      reportEnvelope: envelope,
      decryptKey,
      searchKeyTimestamp: submission.searchKeyTimestamp,
      searchKey: submission.searchKey,
      qRCodeExpired: submission.qRCodeExpired,
      offlineCreated: submission.offlineCreated,
      cashRegisterSignCertificate: submission.cashRegisterSignCertificate,
      recordCounter: submission.recordCounter,
      lastRecordCounter: submission.lastRecordCounter,
      ntcaVerificationCode: submission.ntcaVerificationCode,
      ...(submission.sendMissingDocumentProcessId
        ? { sendMissingDocumentProcessId: submission.sendMissingDocumentProcessId }
        : {}),
    };
    return this.send('report', 'ReportRequest', request) as Promise<ReportResponse>;
  }

  /** Look up a taxpayer's validity and data by tax number. */
  async queryTaxpayer(taxNumber: string): Promise<QueryTaxpayerResponse> {
    const request = { ...this.header(), APNumber: this.apNumber, taxNumber };
    return this.send(
      'queryTaxpayer',
      'QueryTaxpayerRequest',
      request,
    ) as Promise<QueryTaxpayerResponse>;
  }

  /** Look up product data (e.g. VAT rate) by product code. */
  async getProductByCode(productCode: string): Promise<GetProductByCodeResponse> {
    const request = { ...this.header(), APNumber: this.apNumber, productCode };
    return this.send(
      'getProductByCode',
      'GetProductByCodeRequest',
      request,
    ) as Promise<GetProductByCodeResponse>;
  }

  private async send(op: OperationKey, root: string, request: object): Promise<unknown> {
    const xml = serializeDocument(root, request);
    const { value } = await postReceiptXmlSecure(this.url(op), xml, this.transport);
    return value;
  }

  private header(): {
    requestId: string;
    timestamp: string;
    requestVersion: string;
    headerVersion: string;
  } {
    return {
      requestId: createRequestId(this.requestIdPrefix),
      timestamp: toHeaderTimestamp(this.now()),
      requestVersion: RECEIPT_DATA_REQUEST_VERSION,
      headerVersion: RECEIPT_DATA_HEADER_VERSION,
    };
  }

  private url(op: OperationKey): string {
    if (this.endpoints[op]) return this.endpoints[op]!;
    return `${trimTrailingSlash(this.baseUrl)}/${DEFAULT_PATHS[op]}`;
  }
}
