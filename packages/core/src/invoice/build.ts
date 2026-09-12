import { Decimal } from '../money/decimal.js';
import { computeInvoiceSummary } from '../money/summary.js';
import { parseTaxNumber } from '../validation/tax-number.js';
import type { InvoiceData, InvoiceType, LineType, UnitOfMeasureType } from '../generated/types.js';

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

  const line = input.lines.map((entry, index): LineType => {
    const quantity = Decimal.from(entry.quantity);
    const unitPrice = Decimal.from(entry.unitPrice);
    const vatPercentage = Decimal.from(entry.vatPercentage);
    const net = quantity.multiply(unitPrice).round(MONETARY_SCALE);
    const vat = net.multiply(vatPercentage).round(MONETARY_SCALE);
    const gross = net.add(vat);

    return {
      lineNumber: index + 1,
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
        lineVatData: {
          lineVatAmount: vat.toString(),
          lineVatAmountHUF: toHuf(vat),
        },
        lineGrossAmountData: {
          lineGrossAmountNormal: gross.toString(),
          lineGrossAmountNormalHUF: toHuf(gross),
        },
      },
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
    invoiceDetail: {
      invoiceCategory: 'NORMAL',
      invoiceDeliveryDate: deliveryDate,
      currencyCode: currency,
      exchangeRate: rate.toString(),
      ...(input.paymentMethod ? { paymentMethod: input.paymentMethod } : {}),
      ...(input.paymentDate ? { paymentDate: input.paymentDate } : {}),
      invoiceAppearance: input.appearance ?? 'PAPER',
    },
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
