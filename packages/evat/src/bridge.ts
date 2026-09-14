import { Decimal, type InvoiceData, type InvoiceType, type LineType } from '@open-nav/core';
import type {
  PartnerInfoType,
  PartnerStatusType,
  TaxInformationType,
  VatAnalyticsItemType,
  VatAnalyticsType,
} from './generated/types.js';

/**
 * Bridge from open-nav invoice data to eVAT VAT analytics.
 *
 * The declaration's tétel-level VAT ledger is largely the invoices a taxpayer
 * has already reported (outbound) plus their purchase ledger (inbound). This
 * assembles a {@link VatAnalyticsItemType} per invoice — the mechanical part:
 * source-document identity, the partner, and the VAT positions grouped by rate.
 *
 * What it deliberately does NOT do is pick the standard tax code. Classifying a
 * line to one of the ~230 catalogue codes is a VAT-law judgement (rate,
 * exemption ground, domestic/export, reverse charge, …), so the caller supplies
 * it as a policy function — with `@open-nav/evat`'s `TAX_CODES` to draw on.
 */

export type LedgerDirection = 'OUTBOUND' | 'INBOUND';

export interface TaxCodeContext {
  direction: LedgerDirection;
  /** VAT rate as a fraction string, e.g. `0.27`, if the group has one. */
  vatPercentage?: string;
}

export interface BuildVatAnalyticsItemOptions {
  /** Whether this is a sale (PAYABLE) or a purchase (DEDUCTIBLE). */
  direction: LedgerDirection;
  /** 1-based position of this item in the analytics. */
  lineNumber: number;
  /** Classify a VAT-rate group to its standard tax code. */
  taxCode: (context: TaxCodeContext) => string;
}

const SCALE = 2;

/** Build one VAT-analytics item from a single-invoice open-nav document. */
export function buildVatAnalyticsItem(
  document: InvoiceData,
  options: BuildVatAnalyticsItemOptions,
): VatAnalyticsItemType {
  const invoice = document.invoiceMain.invoice;
  if (!invoice) {
    throw new Error('buildVatAnalyticsItem needs a single-invoice document');
  }
  const head = invoice.invoiceHead;
  const detail = head.invoiceDetail;
  const lines = invoice.invoiceLines?.line ?? [];

  const partner: PartnerInfoType =
    options.direction === 'OUTBOUND' ? customerPartner(head) : supplierPartner(head);

  return {
    lineNumber: options.lineNumber,
    sourceDocumentId: document.invoiceNumber,
    sourceDocumentIssueDate: document.invoiceIssueDate,
    sourceDocumentType: 'INVOICE',
    taxpointDate: detail.invoiceDeliveryDate ?? document.invoiceIssueDate,
    invoiceModificationOrCancellation: invoice.invoiceReference !== undefined,
    partnerInfo: partner,
    taxInformation: taxInformation(lines, options),
  };
}

/** Wrap analytics items into a {@link VatAnalyticsType}. */
export function buildVatAnalytics(items: VatAnalyticsItemType[]): VatAnalyticsType {
  return { totalRowCount: items.length, vatAnalyticsItem: items };
}

/** One tax-information block per distinct VAT rate on the invoice. */
function taxInformation(
  lines: LineType[],
  options: BuildVatAnalyticsItemOptions,
): TaxInformationType[] {
  const positionType = options.direction === 'OUTBOUND' ? 'PAYABLE' : 'DEDUCTIBLE';
  const groups = new Map<string, { vatPercentage?: string; base: Decimal; amount: Decimal }>();

  for (const line of lines) {
    const amounts = line.lineAmountsNormal;
    if (!amounts) continue; // e.g. an advance line carrying only a rate
    const vatPercentage = amounts.lineVatRate?.vatPercentage;
    const key = vatPercentage ?? '';
    const group = groups.get(key) ?? {
      vatPercentage,
      base: Decimal.from(0),
      amount: Decimal.from(0),
    };
    group.base = group.base.add(amounts.lineNetAmountData.lineNetAmount);
    if (amounts.lineVatData) group.amount = group.amount.add(amounts.lineVatData.lineVatAmount);
    groups.set(key, group);
  }

  return [...groups.values()].map((group) => ({
    standardTaxCode: options.taxCode({
      direction: options.direction,
      ...(group.vatPercentage !== undefined ? { vatPercentage: group.vatPercentage } : {}),
    }),
    taxPosition: [
      {
        positionType,
        taxBase: group.base.round(SCALE).toString(),
        taxAmount: group.amount.round(SCALE).toString(),
      },
    ],
  }));
}

type InvoiceHead = InvoiceType['invoiceHead'];

function customerPartner(head: InvoiceHead): PartnerInfoType {
  const customer = head.customerInfo;
  const status = partnerStatus(customer?.customerVatStatus);
  const taxNumber = customer?.customerVatData?.customerTaxNumber;
  return {
    partnerStatus: status,
    ...(status !== 'PRIVATE_PERSON' && taxNumber
      ? { partnerTaxData: { domesticTaxData: { taxNumber: formatTaxNumber(taxNumber) } } }
      : {}),
    ...(status !== 'PRIVATE_PERSON' && customer?.customerName
      ? { partnerName: customer.customerName }
      : {}),
  };
}

function supplierPartner(head: InvoiceHead): PartnerInfoType {
  const supplier = head.supplierInfo;
  return {
    partnerStatus: 'DOMESTIC',
    partnerTaxData: { domesticTaxData: { taxNumber: formatTaxNumber(supplier.supplierTaxNumber) } },
    partnerName: supplier.supplierName,
  };
}

function partnerStatus(status: string | undefined): PartnerStatusType {
  switch (status) {
    case 'PRIVATE_PERSON':
      return 'PRIVATE_PERSON';
    case 'OTHER':
      return 'OTHER';
    case 'DOMESTIC':
      return 'DOMESTIC';
    default:
      return 'NOT_AVAILABLE';
  }
}

function formatTaxNumber(parts: {
  taxpayerId: string;
  vatCode?: string;
  countyCode?: string;
}): string {
  // Fixed 8-1-2 layout: the county code only follows a present VAT code, so a
  // missing VAT code can't slide the county code into the VAT-code slot.
  let formatted = parts.taxpayerId;
  if (parts.vatCode) {
    formatted += `-${parts.vatCode}`;
    if (parts.countyCode) formatted += `-${parts.countyCode}`;
  }
  return formatted;
}
