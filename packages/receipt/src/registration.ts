import { createRequestId, toHeaderTimestamp } from '@open-nav/core';
import { serializeDocument } from './codec.js';
import { generateCsr, type CsrResult } from './crypto.js';
import { downloadCertificate, postReceiptXml, type ReceiptTransportOptions } from './transport.js';
import type {
  RegistrationResponse,
  RenewCertificateResponse,
  SoftwareType,
} from './generated/types.js';

/** Interface (data-model) version for the eNyugta bootstrap requests. */
export const RECEIPT_REQUEST_VERSION = '1.0';
export const RECEIPT_HEADER_VERSION = '1.0';

/**
 * Endpoint URLs for the bootstrap (registration / certificate) services.
 *
 * The exact host per environment and the per-operation path are not in the
 * published spec PDF (they live in NAV's apidog); these are best-effort and
 * configurable, to be pinned against the live test system. Pass full URLs via
 * {@link ReceiptRegistrationOptions.endpoints} to override.
 */
export const RECEIPT_BASE_URLS = {
  test: 'https://fam.enyugta.nav.gov.hu',
  production: 'https://fam.enyugta.nav.gov.hu',
} as const;

export interface ReceiptRegistrationOptions {
  /** Base URL for the FAM bootstrap services. */
  baseUrl?: string;
  /** Full per-operation URLs, overriding baseUrl + default path. */
  endpoints?: { register?: string; renewCertificate?: string };
  /** Identification of the calling software. */
  software: SoftwareType;
  now?: () => Date;
  requestIdPrefix?: string;
  transport?: ReceiptTransportOptions;
}

export interface RegisterInput {
  /** The AP number assigned by the e-cash-register distributor. */
  apNumber: string;
  /** The installation/registration code the taxpayer obtained from NAV. */
  registrationNumber: string;
  /** Modem/register IMEI. */
  imei: string;
  /** SIM IMSI. */
  imsi: string;
  /** Authentication-certificate CSR (base64 DER). Generated if omitted. */
  authenticationCsr?: string;
  /** Signing-certificate CSR (base64 DER). Generated if omitted. */
  signingCsr?: string;
}

export interface RegisterResult {
  response: RegistrationResponse;
  /** The CSR key pairs, when the client generated them — store the private keys. */
  authentication?: CsrResult;
  signing?: CsrResult;
}

/**
 * Client for the eNyugta device-registration and certificate-lifecycle
 * (bootstrap) services. These run before the register has any certificate, so
 * the requests are plain XML (unauthenticated); the authenticated data services
 * are a separate client (ONAV-41).
 */
export class ReceiptRegistrationClient {
  private readonly baseUrl: string;
  private readonly endpoints: { register?: string; renewCertificate?: string };
  private readonly software: SoftwareType;
  private readonly now: () => Date;
  private readonly requestIdPrefix: string | undefined;
  private readonly transport: ReceiptTransportOptions;

  constructor(options: ReceiptRegistrationOptions) {
    this.baseUrl = options.baseUrl ?? RECEIPT_BASE_URLS.test;
    this.endpoints = options.endpoints ?? {};
    this.software = options.software;
    this.now = options.now ?? (() => new Date());
    this.requestIdPrefix = options.requestIdPrefix;
    this.transport = options.transport ?? {};
  }

  /**
   * Register a new e-cash register. Generates the auth + signing key pairs and
   * CSRs when they are not supplied, and returns NAV's response (which carries
   * the certificate-download endpoints) alongside any generated key pairs.
   */
  async register(input: RegisterInput): Promise<RegisterResult> {
    const authentication = input.authenticationCsr ? undefined : generateCsr(input.apNumber);
    const signing = input.signingCsr ? undefined : generateCsr(input.apNumber);
    const request = {
      ...this.header(),
      APNumber: input.apNumber,
      registrationNumber: input.registrationNumber,
      imei: input.imei,
      imsi: input.imsi,
      authenticationCertificateRequest: input.authenticationCsr ?? authentication!.csrDerBase64,
      signingCertificateRequest: input.signingCsr ?? signing!.csrDerBase64,
      software: this.software,
    };
    const xml = serializeDocument('RegistrationRequest', request);
    const { value } = await postReceiptXml(this.url('register', 'register'), xml, this.transport);
    return {
      response: value as RegistrationResponse,
      ...(authentication ? { authentication } : {}),
      ...(signing ? { signing } : {}),
    };
  }

  /** Renew an authentication or signing certificate before it expires. */
  async renewCertificate(input: {
    apNumber: string;
    taxNumber: string;
    certificateType: string;
    renewCertificateCode?: string;
    certificateRequest?: string;
  }): Promise<RenewCertificateResponse> {
    const request = {
      ...this.header(),
      APNumber: input.apNumber,
      taxNumber: input.taxNumber,
      ...(input.renewCertificateCode ? { renewCertificateCode: input.renewCertificateCode } : {}),
      certificateType: input.certificateType,
      ...(input.certificateRequest ? { certificateRequest: input.certificateRequest } : {}),
    };
    const xml = serializeDocument('RenewCertificateRequest', request);
    const { value } = await postReceiptXml(
      this.url('renewCertificate', 'renewCertificate'),
      xml,
      this.transport,
    );
    return value as RenewCertificateResponse;
  }

  /**
   * Download an issued certificate from an endpoint NAV returned (waits 5s
   * before the first attempt, as the spec requires).
   */
  downloadCertificate(endpoint: string, waitMs = 5000): Promise<string> {
    return downloadCertificate(endpoint, { ...this.transport, waitMs });
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
      requestVersion: RECEIPT_REQUEST_VERSION,
      headerVersion: RECEIPT_HEADER_VERSION,
    };
  }

  private url(key: 'register' | 'renewCertificate', path: string): string {
    if (this.endpoints[key]) return this.endpoints[key]!;
    let base = this.baseUrl;
    while (base.endsWith('/')) base = base.slice(0, -1);
    return `${base}/${path}`;
  }
}
