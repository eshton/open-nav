import { gzipSync } from 'node:zlib';
import {
  createRequestId,
  passwordHash,
  requestSignature,
  sha3_512,
  sha3_512Bytes,
  toHeaderTimestamp,
  toSignatureTimestamp,
  PASSWORD_HASH_CRYPTO_TYPE,
  SIGNATURE_CRYPTO_TYPE,
  type SoftwareType,
  type NavEnvironment,
} from '@open-nav/core';
import type {
  BasicHeaderType,
  ManageAttachmentUploadResponse,
  ManageDeclarationFinalizeResponse,
  ManageDeclarationPartitionResponse,
  ManageDeclarationSubmissionResponse,
  ManageDeclarationUploadResponse,
  PurgeAttachmentResponse,
  QueryAttachmentListResponse,
  QueryCustomsDeclarationDigestRequest,
  QueryCustomsDeclarationDigestResponse,
  QueryCustomsDeclarationTaxCodeRequest,
  QueryCustomsDeclarationTaxCodeResponse,
  QueryDeclarationDataResponse,
  QueryDeclarationListResponse,
  QueryDeclarationProcessingStatusResponse,
  QueryDocumentListResponse,
  QueryDocumentListResultResponse,
  QueryInvoiceTaxCodeRequest,
  QueryInvoiceTaxCodeResponse,
  QueryTaxCodeCatalogResponse,
  QueryVatDeclarationDataResponse,
  UserHeaderType,
} from './generated/types.js';
import { assertEvatCredentials, type EvatCredentials } from './credentials.js';
import { serializeDocument } from './codec.js';
import {
  postMultipart,
  postXml,
  postXmlForMultipart,
  type EvatDownload,
  type EvatTransportOptions,
  type UploadPart,
} from './transport.js';

/** A request body with the parts the client fills in removed. */
export type EvatRequestBody<T> = Omit<T, 'header' | 'user' | 'software'>;

/** Test and production base URLs for the eVAT M2M interface. */
export const EVAT_BASE_URLS: Record<NavEnvironment, string> = {
  test: 'https://api-test.eafa.nav.gov.hu/analyticsService/v1',
  production: 'https://api.eafa.nav.gov.hu/analyticsService/v1',
};

/** Interface (data-model) version — see the eVAT M2M spec. */
export const EVAT_REQUEST_VERSION = '1.0';
export const EVAT_HEADER_VERSION = '1.0';
/** The only declaration schema NAV currently accepts. */
export const VAT_DECLARATION = 'VAT_DECLARATION';
/** Maximum partition size for manageDeclarationPartition (128 MB). */
export const MAX_PARTITION_BYTES = 128 * 1024 * 1024;
/** NAV rejects more than 16 partitions per upload. */
export const MAX_PARTITION_COUNT = 16;

export interface EvatClientOptions {
  credentials: EvatCredentials;
  /** Identification of the calling software; NAV requires it on every request. */
  software: SoftwareType;
  /** `test` (the default) or `production`. */
  environment?: NavEnvironment;
  /** Overrides `environment`; useful for a mock server. */
  baseUrl?: string;
  /** Prefix for generated request identifiers, for tracing. */
  requestIdPrefix?: string;
  /** Injectable clock, for deterministic tests. */
  now?: () => Date;
  transport?: EvatTransportOptions;
}

/** Body of an upload initiation, minus the parts the client fills in. */
export interface UploadInit {
  partitionCount: number;
  contentHash: string;
  xsdVersion: string;
  requestPeriodStart: string;
  requestPeriodEnd: string;
  attachmentIdList?: { claimCheckId: string[] };
}

export interface SubmitDeclarationInput {
  /** The declaration analytics XML (a `VatDeclarationData` document). */
  declarationXml: string;
  /** earData XSD version the declaration was built against. */
  xsdVersion: string;
  /** Declaration period start, `yyyy-mm-dd`. */
  requestPeriodStart: string;
  /** Declaration period end, `yyyy-mm-dd`. */
  requestPeriodEnd: string;
  /** Attachment claim-check ids to associate with the declaration. */
  attachmentIds?: string[];
  /** Override the partition size (bytes). Defaults to {@link MAX_PARTITION_BYTES}. */
  maxPartitionBytes?: number;
}

export interface SubmitDeclarationResult {
  declarationUploadId: string;
  declarationProcessingId: string;
  partitionCount: number;
  upload: ManageDeclarationUploadResponse;
  finalize: ManageDeclarationFinalizeResponse;
}

/**
 * Client for NAV's eÁFA (eVAT) M2M declaration service.
 *
 * The submission lifecycle is: `manageDeclarationUpload` (declare the content
 * hash + partition count) → `manageDeclarationPartition` (upload the gzipped
 * analytics as one or more binary partitions) → `manageDeclarationFinalize`
 * (begin processing) → poll `queryDeclarationProcessingStatus` until
 * `FINISHED` → `manageDeclarationSubmission`. {@link submitDeclaration} runs the
 * upload/partition/finalize part; polling and submission are separate so the
 * caller controls the (possibly long) wait and the final approval.
 *
 * Authentication reuses the Online Számla technical user: SHA-512 password
 * hash and an SHA3-512 request signature, with the file-upload variant folding
 * the payload's SHA3-512 into the signature (see the EVAT-1 findings).
 */
export class EvatClient {
  private readonly baseUrl: string;
  private readonly credentials: EvatCredentials;
  private readonly software: SoftwareType;
  private readonly requestIdPrefix: string | undefined;
  private readonly now: () => Date;
  private readonly transport: EvatTransportOptions;

  constructor(options: EvatClientOptions) {
    assertEvatCredentials(options.credentials);
    this.credentials = options.credentials;
    this.software = options.software;
    this.baseUrl = options.baseUrl ?? EVAT_BASE_URLS[options.environment ?? 'test'];
    this.requestIdPrefix = options.requestIdPrefix;
    this.now = options.now ?? (() => new Date());
    this.transport = options.transport ?? {};
  }

  /** Initiate an upload: declare the content hash and partition count. */
  manageDeclarationUpload(body: UploadInit): Promise<ManageDeclarationUploadResponse> {
    return this.execute('manageDeclarationUpload', 'ManageDeclarationUploadRequest', {
      partitionCount: body.partitionCount,
      contentHash: { value: body.contentHash, cryptoType: SIGNATURE_CRYPTO_TYPE },
      declarationSchema: VAT_DECLARATION,
      ...(body.attachmentIdList ? { attachmentIdList: body.attachmentIdList } : {}),
      xsdVersion: body.xsdVersion,
      requestPeriodStart: body.requestPeriodStart,
      requestPeriodEnd: body.requestPeriodEnd,
    });
  }

  /** Upload one gzipped analytics partition (multipart, 1-based serial). */
  manageDeclarationPartition(
    declarationUploadId: string,
    partition: number,
    bytes: Uint8Array,
  ): Promise<ManageDeclarationPartitionResponse> {
    return this.executeUpload(
      'manageDeclarationPartition',
      'ManageDeclarationPartitionRequest',
      { declarationUploadId, partition },
      { bytes, fileName: `partition-${partition}.gz` },
    );
  }

  /** Signal that all partitions are uploaded; begins processing. */
  manageDeclarationFinalize(
    declarationUploadId: string,
  ): Promise<ManageDeclarationFinalizeResponse> {
    return this.execute('manageDeclarationFinalize', 'ManageDeclarationFinalizeRequest', {
      declarationUploadId,
      // Reserved for future use; the spec requires false.
      preliminaryConfirmation: false,
    });
  }

  /** Processing state of a declaration, by its processing id. */
  queryDeclarationProcessingStatus(
    declarationProcessingId: string,
  ): Promise<QueryDeclarationProcessingStatusResponse> {
    return this.execute(
      'queryDeclarationProcessingStatus',
      'QueryDeclarationProcessingStatusRequest',
      { declarationProcessingId, declarationSchema: VAT_DECLARATION },
    );
  }

  /** Submit (approve) a declaration that has reached FINISHED. */
  manageDeclarationSubmission(
    declarationProcessingId: string,
  ): Promise<ManageDeclarationSubmissionResponse> {
    return this.execute('manageDeclarationSubmission', 'ManageDeclarationSubmissionRequest', {
      declarationProcessingId,
      declarationSchema: VAT_DECLARATION,
    });
  }

  /** Upload a declaration attachment (multipart); returns its claim-check id. */
  manageAttachmentUpload(
    meta: { fileName: string; fileExtension: string },
    bytes: Uint8Array,
  ): Promise<ManageAttachmentUploadResponse> {
    return this.executeUpload(
      'manageAttachmentUpload',
      'ManageAttachmentUploadRequest',
      {
        fileName: meta.fileName,
        fileExtension: meta.fileExtension,
        contentHash: { value: sha3_512Bytes(bytes), cryptoType: SIGNATURE_CRYPTO_TYPE },
      },
      { bytes, fileName: `${meta.fileName}.${meta.fileExtension}` },
    );
  }

  /** Delete a previously uploaded attachment by its claim-check id. */
  purgeAttachment(claimCheckId: string): Promise<PurgeAttachmentResponse> {
    return this.execute('purgeAttachment', 'PurgeAttachmentRequest', { claimCheckId });
  }

  /** List the attachments in the taxpayer's repository. */
  queryAttachmentList(): Promise<QueryAttachmentListResponse> {
    return this.execute('queryAttachmentList', 'QueryAttachmentListRequest', {});
  }

  // ---- read-only queries ("see my returns") -----------------------------

  /** List the taxpayer's declarations filed in a fulfilment-date window. */
  queryDeclarationList(range: {
    taxpointDateFrom: string;
    taxpointDateTo: string;
  }): Promise<QueryDeclarationListResponse> {
    return this.execute('queryDeclarationList', 'QueryDeclarationListRequest', range);
  }

  /** NAV's compiled VAT-return (BEVFELD) data for a processed declaration. */
  /**
   * NAV's compiled VAT-return (BEVFELD) data for a processed declaration.
   *
   * The response is `multipart/form-data`: the parsed XML (`value`) plus the
   * compiled data as the octet-stream `payload` (confirmed live, EVAT-10). Use
   * {@link decodeDownloadPayload} to turn the bytes into the XML document.
   */
  queryVatDeclarationData(declarationProcessingId: string): Promise<EvatDownload> {
    const requestId = createRequestId(this.requestIdPrefix);
    const timestamp = toHeaderTimestamp(this.now());
    const signature = requestSignature(requestId, timestamp, this.credentials.signKey);
    const request = {
      ...this.envelope(requestId, timestamp, signature),
      declarationProcessingId,
      declarationSchema: VAT_DECLARATION,
    };
    const xml = serializeDocument('QueryVatDeclarationDataRequest', request);
    return postXmlForMultipart(this.baseUrl, 'queryVatDeclarationData', xml, this.transport);
  }

  /**
   * Read a submitted declaration's own data (the analytics as filed).
   *
   * NAV returns the data inline in the XML (`value.declarationData`), so
   * `payload` is normally absent; the multipart download path is used only
   * because NAV may switch to a `file` part for a large declaration, in which
   * case `payload` carries the (gzipped) bytes — see {@link decodeDownloadPayload}.
   * For NAV's compiled VAT-return figures use {@link queryVatDeclarationData}.
   */
  queryDeclarationData(declarationProcessingId: string): Promise<EvatDownload> {
    const requestId = createRequestId(this.requestIdPrefix);
    const timestamp = toHeaderTimestamp(this.now());
    const signature = requestSignature(requestId, timestamp, this.credentials.signKey);
    const request = {
      ...this.envelope(requestId, timestamp, signature),
      declarationProcessingId,
      declarationSchema: VAT_DECLARATION,
    };
    const xml = serializeDocument('QueryDeclarationDataRequest', request);
    return postXmlForMultipart(this.baseUrl, 'queryDeclarationData', xml, this.transport);
  }

  /** List documents (declarations and their events) in a date window. */
  queryDocumentList(range: {
    taxpointDateFrom: string;
    taxpointDateTo: string;
  }): Promise<QueryDocumentListResponse> {
    return this.execute('queryDocumentList', 'QueryDocumentListRequest', range);
  }

  /** Fetch the result of a document-list query by its query id. */
  queryDocumentListResult(queryId: string): Promise<QueryDocumentListResultResponse> {
    return this.execute('queryDocumentListResult', 'QueryDocumentListResultRequest', { queryId });
  }

  /** The tax-code catalogue valid on a given date. */
  queryTaxCodeCatalog(taxpointDate: string): Promise<QueryTaxCodeCatalogResponse> {
    return this.execute('queryTaxCodeCatalog', 'QueryTaxCodeCatalogRequest', { taxpointDate });
  }

  /** Tax-code lookup for a specific invoice. */
  queryInvoiceTaxCode(
    body: EvatRequestBody<QueryInvoiceTaxCodeRequest>,
  ): Promise<QueryInvoiceTaxCodeResponse> {
    return this.execute('queryInvoiceTaxCode', 'QueryInvoiceTaxCodeRequest', body);
  }

  /** Tax-code lookup for a customs declaration. */
  queryCustomsDeclarationTaxCode(
    body: EvatRequestBody<QueryCustomsDeclarationTaxCodeRequest>,
  ): Promise<QueryCustomsDeclarationTaxCodeResponse> {
    return this.execute(
      'queryCustomsDeclarationTaxCode',
      'QueryCustomsDeclarationTaxCodeRequest',
      body,
    );
  }

  /** Paged digest of customs declarations matching a query. */
  queryCustomsDeclarationDigest(
    body: EvatRequestBody<QueryCustomsDeclarationDigestRequest>,
  ): Promise<QueryCustomsDeclarationDigestResponse> {
    return this.execute(
      'queryCustomsDeclarationDigest',
      'QueryCustomsDeclarationDigestRequest',
      body,
    );
  }

  /**
   * Run the upload → partition → finalize part of the lifecycle for a
   * declaration XML, returning the processing id to poll and then submit.
   *
   * The content hash is the SHA3-512 of the (uncompressed) declaration XML; the
   * payload is gzipped and split into partitions, as the spec prescribes.
   */
  async submitDeclaration(input: SubmitDeclarationInput): Promise<SubmitDeclarationResult> {
    const xmlBytes = new TextEncoder().encode(input.declarationXml);
    const contentHash = sha3_512Bytes(xmlBytes);
    const gzipped = new Uint8Array(gzipSync(xmlBytes));
    const partitions = splitPartitions(gzipped, input.maxPartitionBytes ?? MAX_PARTITION_BYTES);
    if (partitions.length > MAX_PARTITION_COUNT) {
      throw new Error(
        `declaration splits into ${partitions.length} partitions; NAV accepts at most ${MAX_PARTITION_COUNT}`,
      );
    }

    const upload = await this.manageDeclarationUpload({
      partitionCount: partitions.length,
      contentHash,
      xsdVersion: input.xsdVersion,
      requestPeriodStart: input.requestPeriodStart,
      requestPeriodEnd: input.requestPeriodEnd,
      ...(input.attachmentIds?.length
        ? { attachmentIdList: { claimCheckId: input.attachmentIds } }
        : {}),
    });

    const declarationUploadId = upload.declarationUploadId;
    for (const [index, partition] of partitions.entries()) {
      await this.manageDeclarationPartition(declarationUploadId, index + 1, partition);
    }

    const finalize = await this.manageDeclarationFinalize(declarationUploadId);
    return {
      declarationUploadId,
      declarationProcessingId: finalize.declarationProcessingId,
      partitionCount: partitions.length,
      upload,
      finalize,
    };
  }

  /** Build, sign and send one XML request. */
  private async execute<TResponse>(
    operation: string,
    rootName: string,
    body: object,
  ): Promise<TResponse> {
    const requestId = createRequestId(this.requestIdPrefix);
    const timestamp = toHeaderTimestamp(this.now());
    const signature = requestSignature(requestId, timestamp, this.credentials.signKey);
    const request = { ...this.envelope(requestId, timestamp, signature), ...body };
    const xml = serializeDocument(rootName, request);
    const response = await postXml(this.baseUrl, operation, xml, this.transport);
    return response.value as TResponse;
  }

  /** Build, sign (file-hash variant) and send one multipart upload. */
  private async executeUpload<TResponse>(
    operation: string,
    rootName: string,
    body: object,
    part: UploadPart,
  ): Promise<TResponse> {
    const requestId = createRequestId(this.requestIdPrefix);
    const timestamp = toHeaderTimestamp(this.now());
    // File-upload signature: SHA3-512 over (requestId + masked timestamp +
    // signKey + uppercase SHA3-512 of the uploaded bytes).
    const signature = sha3_512(
      `${requestId}${toSignatureTimestamp(timestamp)}${this.credentials.signKey}${sha3_512Bytes(part.bytes)}`,
    );
    const request = { ...this.envelope(requestId, timestamp, signature), ...body };
    const xml = serializeDocument(rootName, request);
    const response = await postMultipart(this.baseUrl, operation, xml, part, this.transport);
    return response.value as TResponse;
  }

  private envelope(
    requestId: string,
    timestamp: string,
    signature: string,
  ): { header: BasicHeaderType; user: UserHeaderType; software: SoftwareType } {
    return {
      header: {
        requestId,
        timestamp,
        requestVersion: EVAT_REQUEST_VERSION,
        headerVersion: EVAT_HEADER_VERSION,
      },
      user: {
        login: this.credentials.login,
        passwordHash: {
          value: passwordHash(this.credentials.password),
          cryptoType: PASSWORD_HASH_CRYPTO_TYPE,
        },
        taxNumber: this.credentials.taxNumber,
        requestSignature: { value: signature, cryptoType: SIGNATURE_CRYPTO_TYPE },
      },
      software: this.software,
    };
  }
}

/** Split a byte array into chunks no larger than `maxBytes`. */
export function splitPartitions(bytes: Uint8Array, maxBytes: number): Uint8Array[] {
  if (maxBytes <= 0) throw new Error('maxBytes must be positive');
  if (bytes.length === 0) return [bytes];
  const parts: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length; offset += maxBytes) {
    parts.push(bytes.subarray(offset, Math.min(offset + maxBytes, bytes.length)));
  }
  return parts;
}
