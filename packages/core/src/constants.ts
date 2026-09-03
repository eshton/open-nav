/**
 * Protocol level constants for the NAV Online Számla (Online Invoice) system.
 *
 * The reference documentation is published by NAV at
 * https://onlineszamla.nav.gov.hu/dokumentaciok — this library targets
 * interface version 3.0 of the invoice service.
 */

/** XML namespace of the invoice service request/response envelopes. */
export const NS_API = 'http://schemas.nav.gov.hu/OSA/3.0/api';

/** XML namespace of the invoice payload (`InvoiceData`). */
export const NS_DATA = 'http://schemas.nav.gov.hu/OSA/3.0/data';

/** XML namespace of shared invoice building blocks (addresses, tax numbers). */
export const NS_BASE = 'http://schemas.nav.gov.hu/OSA/3.0/base';

/** XML namespace of the annulment payload (`InvoiceAnnulment`). */
export const NS_ANNUL = 'http://schemas.nav.gov.hu/OSA/3.0/annul';

/** XML namespace of the NTCA common header/user blocks. */
export const NS_COMMON = 'http://schemas.nav.gov.hu/NTCA/1.0/common';

/** Value of `header/requestVersion` for this interface version. */
export const REQUEST_VERSION = '3.0';

/** Value of `header/headerVersion` for this interface version. */
export const HEADER_VERSION = '1.0';

/** Base URL of the NAV production invoice service. */
export const PRODUCTION_BASE_URL = 'https://api.onlineszamla.nav.gov.hu/invoiceService/v1';

/** Base URL of the NAV test ("teszt") invoice service. */
export const TEST_BASE_URL = 'https://api-test.onlineszamla.nav.gov.hu/invoiceService/v1';

/** Well known NAV environments and their base URLs. */
export const BASE_URLS = {
  production: PRODUCTION_BASE_URL,
  test: TEST_BASE_URL,
} as const;

export type NavEnvironment = keyof typeof BASE_URLS;

/** Operation names (path segments) exposed by the invoice service. */
export const OPERATIONS = [
  'tokenExchange',
  'manageInvoice',
  'manageAnnulment',
  'queryTransactionStatus',
  'queryTransactionList',
  'queryInvoiceData',
  'queryInvoiceDigest',
  'queryInvoiceChainDigest',
  'queryInvoiceCheck',
  'queryTaxpayer',
] as const;

export type NavOperation = (typeof OPERATIONS)[number];

/**
 * Maximum number of invoice operations NAV accepts in a single
 * `manageInvoice` request.
 */
export const MAX_INVOICE_BATCH_SIZE = 100;

/** Page size used by NAV for every paged query response. */
export const QUERY_PAGE_SIZE = 100;

/**
 * Maximum length of the `requestId` header field. NAV also requires it to be
 * unique per taxpayer, forever.
 */
export const REQUEST_ID_MAX_LENGTH = 30;

/** Characters NAV allows in a `requestId`. */
export const REQUEST_ID_PATTERN = /^[+a-zA-Z0-9_]{1,30}$/;
