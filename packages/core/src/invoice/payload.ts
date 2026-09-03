import { gunzipSync, gzipSync } from 'node:zlib';
import { NavValidationError } from '../errors.js';
import type { InvoiceAnnulment, InvoiceData } from '../generated/types.js';
import { parseDocumentAs } from '../xml/read.js';
import { serializeDocument, type SerializeOptions } from '../xml/write.js';

/** Gzip magic bytes, used to detect compression regardless of what NAV claims. */
const GZIP_MAGIC = [0x1f, 0x8b];

export interface EncodeOptions extends SerializeOptions {
  /**
   * Gzip the XML before base64 encoding.
   *
   * NAV allows this for `manageInvoice` and it materially reduces payload
   * size, but the whole batch must then set `compressedContent` — the flag is
   * per request, not per invoice.
   */
  compress?: boolean;
}

/**
 * Serialise an invoice to the base64 form carried in `invoiceData`.
 *
 * The returned string is exactly what must be hashed for the request
 * signature, which is why encoding and hashing must never be done from two
 * separately serialised copies of the same invoice.
 */
export function encodeInvoiceData(invoice: InvoiceData, options: EncodeOptions = {}): string {
  return encodeDocument('InvoiceData', invoice, options);
}

/** Serialise an annulment to the base64 form carried in `invoiceAnnulment`. */
export function encodeInvoiceAnnulment(
  annulment: InvoiceAnnulment,
  options: EncodeOptions = {},
): string {
  return encodeDocument('InvoiceAnnulment', annulment, options);
}

function encodeDocument(root: string, value: unknown, options: EncodeOptions): string {
  const { compress, ...serializeOptions } = options;
  const xml = serializeDocument(root, value, serializeOptions);
  const bytes = Buffer.from(xml, 'utf8');
  return (compress ? gzipSync(bytes) : bytes).toString('base64');
}

export interface DecodeOptions {
  /**
   * Whether the payload is gzipped, normally from NAV's
   * `compressedContentIndicator`.
   *
   * Leave it unset to detect compression from the payload itself, which is
   * more robust: the indicator describes the batch as submitted, and reading
   * it wrongly turns a valid invoice into an XML parse error.
   */
  compressed?: boolean;
}

/** Decode a base64 `invoiceData` payload from a NAV query response. */
export function decodeInvoiceData(base64: string, options: DecodeOptions = {}): InvoiceData {
  return parseDocumentAs<InvoiceData>(decodeToXml(base64, options), 'InvoiceData', {
    unknownElements: 'ignore',
  });
}

/** Decode a base64 `invoiceAnnulment` payload. */
export function decodeInvoiceAnnulment(
  base64: string,
  options: DecodeOptions = {},
): InvoiceAnnulment {
  return parseDocumentAs<InvoiceAnnulment>(decodeToXml(base64, options), 'InvoiceAnnulment', {
    unknownElements: 'ignore',
  });
}

/** Decode a base64 payload to its XML text, decompressing when needed. */
export function decodeToXml(base64: string, options: DecodeOptions = {}): string {
  const bytes = Buffer.from(base64.replace(/\s+/g, ''), 'base64');
  if (bytes.length === 0) {
    throw new NavValidationError('Empty base64 payload', [
      { path: '', code: 'EMPTY_PAYLOAD', message: 'decoded to zero bytes' },
    ]);
  }

  const looksGzipped = bytes[0] === GZIP_MAGIC[0] && bytes[1] === GZIP_MAGIC[1];
  const compressed = options.compressed ?? looksGzipped;
  if (!compressed) return bytes.toString('utf8');

  try {
    return gunzipSync(bytes).toString('utf8');
  } catch (cause) {
    throw new NavValidationError('Could not decompress payload', [
      {
        path: '',
        code: 'DECOMPRESSION_FAILED',
        message: looksGzipped
          ? (cause as Error).message
          : 'was declared compressed but does not start with the gzip magic bytes',
      },
    ]);
  }
}
