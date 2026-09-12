import { Decimal } from '../money/decimal.js';
import { computeInvoiceSummary } from '../money/summary.js';
import { parseTaxNumber } from '../validation/tax-number.js';
import type {
  AdditionalDataType,
  AdvanceDataType,
  InvoiceData,
  InvoiceDetailType,
  InvoiceType,
  LineType,
  UnitOfMeasureType,
} from '../generated/types.js';

/**
 * A convenience builder for the common invoice.
 *
 * Constructing an {@link InvoiceData} by hand means filling in ~50 nested
 * fields across four namespaces. This assembles a schema-valid document for the
 * ordinary case — a normal invoice with priced lines — from a flat input,
 * computing each line's net, VAT and gross and the whole invoice summary so the
 * arithmetic always reconciles.
 *
 * It deliberately does not cover the entire schema (no aggregate or simplified
 * invoices, product-fee lines, margin schemes, and so on). For those, build the
 * {@link InvoiceData} directly — this returns exactly that type, so a caller can
 * take the result and adjust it. Validate the result with `validateInvoice`
 * before sending, as with any invoice.
 */

const MONETARY_SCALE = 2;
// Net unit prices derived from a gross price keep extra decimals so that
// `quantity × unitPrice` still rounds to the reported net line amount.
const UNIT_PRICE_SCALE = 6;

export interface BuildAddress {
  /** ISO 3166 alpha-2. Defaults to `HU`. */
  countryCode?: string;
  postalCode: string;
  city: string;
  streetName: string;
  /** e.g. `utca`, `sugárút`. */
  publicPlaceCategory: string;
  /** House number. */
  number: string;
}

export interface BuildParty {
  name: string;
  /** 8- or 11-digit Hungarian tax number; parsed into its parts. */
  taxNumber?: string;
  address: BuildAddress;
}

export interface BuildLine {
  description: string;
  quantity: number | string;
  /** Unit of measure. Defaults to `PIECE`. */
  unit?: UnitOfMeasureType;
  /** Net unit price, in the invoice currency. */
  unitPrice: number | string;
  /** VAT rate as a fraction, e.g. `0.27`. */
  vatPercentage: number | string;
  /** Defaults to `PRODUCT`. */
  nature?: 'PRODUCT' | 'SERVICE' | 'OTHER';
  /**
   * Mark this line as an advance (előleg) charge (`advanceData`).
   *
   * - `true` reports the advance itself — a line of an advance invoice
   *   (előlegszámla). NAV's advance-invoice lines carry only the net amount and
   *   the VAT rate; the builder omits `lineVatData`/`lineGrossAmountData` for
   *   these lines (the summary still derives the VAT from the rate).
   * - An object additionally references the advance invoice that already
   *   reported the payment — the advance-deduction line of a final invoice
   *   (végszámla). Such a line's amounts are the caller's to make negative.
   */
  advance?:
    | boolean
    | {
        /** Number of the advance invoice that reported the payment. */
        originalInvoice: string;
        /** Date the advance was paid, `yyyy-mm-dd`. */
        paymentDate: string;
        /** Exchange rate applied to the advance. Defaults to the invoice rate. */
        exchangeRate?: number | string;
      };
  /**
   * Conventionally named extra data for this line (`additionalLineData`). NAV
   * has no free-text line note; a "Tétel megjegyzés" must be a structured field
   * whose `dataName` follows NAV's `[A-Z][0-9]{5}_...` convention. Validated by
   * `validateInvoice`.
   */
  additionalData?: AdditionalDataType[];
}

export interface BuildInvoiceInput {
  invoiceNumber: string;
  /** Issue date, `yyyy-mm-dd`. */
  issueDate: string;
  /** Fulfilment date, `yyyy-mm-dd`. Defaults to the issue date. */
  deliveryDate?: string;
  /** Payment due date, `yyyy-mm-dd`. */
  paymentDate?: string;
  /** ISO 4217. Defaults to `HUF`. */
  currency?: string;
  /** Rate to HUF. Required for a non-HUF invoice; defaults to `1`. */
  exchangeRate?: number | string;
  /** Defaults to `PAPER`. */
  appearance?: 'PAPER' | 'ELECTRONIC' | 'EDI' | 'UNKNOWN';
  paymentMethod?: 'TRANSFER' | 'CASH' | 'CARD' | 'VOUCHER' | 'OTHER';
  /**
   * How each line's `unitPrice` is entered. `net` (the default) takes it as the
   * net unit price. `gross` takes it as the gross (VAT-inclusive) unit price and
   * derives the net one from the line's VAT rate — the common "bruttó árból"
   * data-entry mode. Because NAV is net-based, the reported gross line total may
   * differ from `quantity × grossUnitPrice` by a rounding unit.
   */
  priceMode?: 'net' | 'gross';
  /**
   * Periodic (continuous) settlement — "folyamatos teljesítés". Sets the
   * delivery period on the invoice and marks `periodicalSettlement`.
   */
  deliveryPeriod?: { start: string; end: string };
  /** Order numbers — "rendelésszám(ok)" (`conventionalInvoiceInfo.orderNumbers`). */
  orderNumbers?: string[];
  /**
   * Conventionally named extra data for the invoice (`additionalInvoiceData`).
   * NAV has no free-text invoice note; an invoice-level "Megjegyzés" must be a
   * structured field whose `dataName` follows NAV's `[A-Z][0-9]{5}_...`
   * convention. Validated by `validateInvoice`.
   */
  additionalData?: AdditionalDataType[];
  supplier: BuildParty & { bankAccount?: string };
  customer: BuildParty & {
    /** Defaults to `DOMESTIC` when a tax number is given, else `PRIVATE_PERSON`. */
    vatStatus?: 'DOMESTIC' | 'OTHER' | 'PRIVATE_PERSON';
  };
  lines: BuildLine[];
}

/** Build a schema-valid {@link InvoiceData} for a normal invoice. */
export function buildInvoice(input: BuildInvoiceInput): InvoiceData {
  if (input.lines.length === 0) {
    throw new Error('buildInvoice requires at least one line');
  }

  const currency = input.currency ?? 'HUF';
  const rate = Decimal.from(input.exchangeRate ?? 1);
  const deliveryDate = input.deliveryDate ?? input.issueDate;
  const toHuf = (amount: Decimal): string => amount.multiply(rate).round(MONETARY_SCALE).toString();

  const grossPriced = input.priceMode === 'gross';

  const line = input.lines.map((entry, index): LineType => {
    const quantity = Decimal.from(entry.quantity);
    const vatPercentage = Decimal.from(entry.vatPercentage);
    // NAV's `unitPrice` is always the net unit price. In gross entry mode the
    // caller gives the VAT-inclusive price, so divide it back out (kept at a
    // wide scale so `quantity × unitPrice` still reconciles to the net line).
    const unitPrice = grossPriced
      ? Decimal.from(entry.unitPrice).divide(Decimal.from(1).add(vatPercentage), UNIT_PRICE_SCALE)
      : Decimal.from(entry.unitPrice);
    const net = quantity.multiply(unitPrice).round(MONETARY_SCALE);
    const vat = net.multiply(vatPercentage).round(MONETARY_SCALE);
    const gross = net.add(vat);

    // A pure advance line (advanceIndicator with no payment reference) reports
    // only its net amount and the VAT rate, as NAV's advance-invoice sample
    // does; the summary derives the VAT. A deduction line on a final invoice
    // carries the full amounts (negated by the caller).
    const advanceData = advanceOf(entry.advance, rate);
    const bareAdvance = entry.advance === true;

    return {
      lineNumber: index + 1,
      ...(advanceData ? { advanceData } : {}),
      lineExpressionIndicator: true,
      lineNatureIndicator: entry.nature ?? 'PRODUCT',
      lineDescription: entry.description,
      quantity: quantity.toString(),
      unitOfMeasure: entry.unit ?? 'PIECE',
      unitPrice: unitPrice.toString(),
      unitPriceHUF: toHuf(unitPrice),
      lineAmountsNormal: {
        lineNetAmountData: {
          lineNetAmount: net.toString(),
          lineNetAmountHUF: toHuf(net),
        },
        lineVatRate: { vatPercentage: vatPercentage.toString() },
        ...(bareAdvance
          ? {}
          : {
              lineVatData: {
                lineVatAmount: vat.toString(),
                lineVatAmountHUF: toHuf(vat),
              },
              lineGrossAmountData: {
                lineGrossAmountNormal: gross.toString(),
                lineGrossAmountNormalHUF: toHuf(gross),
              },
            }),
      },
      ...(entry.additionalData?.length ? { additionalLineData: entry.additionalData } : {}),
    };
  });

  const invoiceLines: InvoiceType['invoiceLines'] = { mergedItemIndicator: false, line };

  const customerHasTaxNumber = input.customer.taxNumber !== undefined;
  const customerVatStatus =
    input.customer.vatStatus ?? (customerHasTaxNumber ? 'DOMESTIC' : 'PRIVATE_PERSON');

  const invoiceHead: InvoiceType['invoiceHead'] = {
    supplierInfo: {
      supplierTaxNumber: parseTaxNumber(requireTaxNumber(input.supplier.taxNumber, 'supplier')),
      supplierName: input.supplier.name,
      supplierAddress: { detailedAddress: address(input.supplier.address) },
      ...(input.supplier.bankAccount
        ? { supplierBankAccountNumber: input.supplier.bankAccount }
        : {}),
    },
    // A private person's identifying data must not be reported to NAV — only
    // the status. NAV rejects name/address/tax data for a private buyer
    // (CUSTOMER_DATA_NOT_EXPECTED), so the builder omits it.
    customerInfo:
      customerVatStatus === 'PRIVATE_PERSON'
        ? { customerVatStatus }
        : {
            customerVatStatus,
            ...(customerHasTaxNumber
              ? {
                  customerVatData: {
                    customerTaxNumber: parseTaxNumber(input.customer.taxNumber!),
                  },
                }
              : {}),
            customerName: input.customer.name,
            customerAddress: { detailedAddress: address(input.customer.address) },
          },
    invoiceDetail: buildInvoiceDetail(input, currency, rate, deliveryDate),
  };

  // Compute the summary from the finished lines so it always reconciles.
  const invoiceSummary = computeInvoiceSummary({ invoiceHead, invoiceLines } as InvoiceType);

  const invoice: InvoiceType = { invoiceHead, invoiceLines, invoiceSummary };

  return {
    invoiceNumber: input.invoiceNumber,
    invoiceIssueDate: input.issueDate,
    completenessIndicator: false,
    invoiceMain: { invoice },
  };
}

/**
 * Build an advance invoice (előlegszámla).
 *
 * An advance invoice reports a prepayment: a NORMAL invoice whose lines are
 * advance charges (`advanceData.advanceIndicator`). Any line not already marked
 * is marked as an advance. Later, the final invoice (végszámla) settles it —
 * build that with `buildInvoice`, adding a deduction line per advance whose
 * `advance` option references this invoice's number and whose amounts are
 * negative.
 */
export function buildAdvanceInvoice(input: BuildInvoiceInput): InvoiceData {
  return buildInvoice({
    ...input,
    lines: input.lines.map((entry) => ({ ...entry, advance: entry.advance ?? true })),
  });
}

function advanceOf(
  advance: BuildLine['advance'],
  invoiceRate: Decimal,
): AdvanceDataType | undefined {
  if (!advance) return undefined;
  if (advance === true) return { advanceIndicator: true };
  return {
    advanceIndicator: true,
    advancePaymentData: {
      advanceOriginalInvoice: advance.originalInvoice,
      advancePaymentDate: advance.paymentDate,
      advanceExchangeRate: Decimal.from(advance.exchangeRate ?? invoiceRate).toString(),
    },
  };
}

export interface BuildStornoOptions {
  /** Number of the storno invoice itself (distinct from the original). */
  invoiceNumber: string;
  /** Issue date of the storno; defaults to the original's. */
  issueDate?: string;
  /** Position of this modification in the chain. Defaults to 1. */
  modificationIndex?: number;
}

/**
 * Build a storno (full cancellation) of an invoice.
 *
 * NAV models a storno as a modifying report: an `invoiceReference` to the
 * original, every line's amounts reversed, and each line carrying a
 * `lineModificationReference`. Two NAV rules the shape must satisfy, both
 * learned from the live service: `lineOperation` is always `CREATE` on a
 * modifying line, and the reversing lines take chain positions *after* the
 * original (`lineNumberReference` continues past it) while the document's own
 * line numbers stay 1..N. Amounts and the summary are negated.
 *
 * Handles the common single-invoice, first-modification case; chained
 * modifications (modificationIndex > 1) are the caller's to sequence.
 */
export function buildStorno(original: InvoiceData, options: BuildStornoOptions): InvoiceData {
  const doc = structuredClone(original);
  doc.invoiceNumber = options.invoiceNumber;
  if (options.issueDate) doc.invoiceIssueDate = options.issueDate;

  const invoice = doc.invoiceMain.invoice;
  if (!invoice) throw new Error('buildStorno needs a single-invoice document');

  const lines = invoice.invoiceLines?.line ?? [];
  const originalCount = lines.length;

  invoice.invoiceReference = {
    originalInvoiceNumber: original.invoiceNumber,
    modifyWithoutMaster: false,
    modificationIndex: options.modificationIndex ?? 1,
  };

  lines.forEach((line, index) => {
    // Document line numbers stay 1..N; the reference continues the chain.
    line.lineModificationReference = {
      lineNumberReference: originalCount + index + 1,
      lineOperation: 'CREATE',
    };
    // Reverse the quantity too, so quantity x unitPrice still equals the
    // (negated) net; the unit price itself stays positive.
    if (line.quantity !== undefined) negateAmount(line, 'quantity');
    const amounts = line.lineAmountsNormal;
    if (!amounts) return;
    negateAmount(amounts.lineNetAmountData, 'lineNetAmount');
    negateAmount(amounts.lineNetAmountData, 'lineNetAmountHUF');
    if (amounts.lineVatData) {
      negateAmount(amounts.lineVatData, 'lineVatAmount');
      negateAmount(amounts.lineVatData, 'lineVatAmountHUF');
    }
    if (amounts.lineGrossAmountData) {
      negateAmount(amounts.lineGrossAmountData, 'lineGrossAmountNormal');
      negateAmount(amounts.lineGrossAmountData, 'lineGrossAmountNormalHUF');
    }
  });

  invoice.invoiceSummary = computeInvoiceSummary(invoice);
  return doc;
}

function negateAmount(target: object, key: string): void {
  const record = target as Record<string, string | undefined>;
  const value = record[key];
  if (value !== undefined) record[key] = Decimal.from(value).negate().toString();
}

function buildInvoiceDetail(
  input: BuildInvoiceInput,
  currency: string,
  rate: Decimal,
  deliveryDate: string,
): InvoiceDetailType {
  const period = input.deliveryPeriod;
  const orderNumbers = input.orderNumbers?.filter((value) => value.length > 0) ?? [];
  return {
    invoiceCategory: 'NORMAL',
    invoiceDeliveryDate: deliveryDate,
    ...(period
      ? { invoiceDeliveryPeriodStart: period.start, invoiceDeliveryPeriodEnd: period.end }
      : {}),
    ...(period ? { periodicalSettlement: true } : {}),
    currencyCode: currency,
    exchangeRate: rate.toString(),
    ...(input.paymentMethod ? { paymentMethod: input.paymentMethod } : {}),
    ...(input.paymentDate ? { paymentDate: input.paymentDate } : {}),
    invoiceAppearance: input.appearance ?? 'PAPER',
    ...(orderNumbers.length
      ? { conventionalInvoiceInfo: { orderNumbers: { orderNumber: orderNumbers } } }
      : {}),
    ...(input.additionalData?.length ? { additionalInvoiceData: input.additionalData } : {}),
  };
}

function address(input: BuildAddress): {
  countryCode: string;
  postalCode: string;
  city: string;
  streetName: string;
  publicPlaceCategory: string;
  number: string;
} {
  return {
    countryCode: input.countryCode ?? 'HU',
    postalCode: input.postalCode,
    city: input.city,
    streetName: input.streetName,
    publicPlaceCategory: input.publicPlaceCategory,
    number: input.number,
  };
}

function requireTaxNumber(value: string | undefined, role: string): string {
  if (!value) throw new Error(`buildInvoice requires the ${role} tax number`);
  return value;
}
