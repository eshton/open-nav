import type { InvoiceData, InvoiceType, LineType, SummaryType } from '../generated/types.js';
import { Decimal } from '../money/decimal.js';
import { checkInvoiceSummary, hasAmountBearingLines } from '../money/summary.js';
import type { IssueCollector } from './issue.js';
import { isValidCountyCode, isValidTaxpayerId } from './tax-number.js';

/**
 * Business rules that are decidable from the document alone.
 *
 * Each rule reports NAV's own fault code where one exists, so a local failure
 * names exactly what the service would have said. Rules that need state only
 * NAV holds — whether an invoice number was used before, whether a referenced
 * invoice exists, whether a tax number is registered — cannot be checked here
 * and are listed in `LOCALLY_UNDECIDABLE` for the record.
 */

export interface InvoiceValidationContext {
  /**
   * The operation the document will be submitted under.
   *
   * Several rules depend on it: an original invoice must not reference
   * another document, and a modification must.
   */
  operation?: 'CREATE' | 'MODIFY' | 'STORNO';
  /**
   * The tax number the request authenticates as. NAV rejects a report whose
   * supplier is someone else.
   */
  supplierTaxNumber?: string;
  /** Today's date as `yyyy-mm-dd`, for the date rules. Defaults to the system date. */
  today?: string;
}

/** Current Hungarian VAT rates, for a plausibility warning only. */
const KNOWN_VAT_RATES = ['0', '0.05', '0.18', '0.27'];

/**
 * Faults NAV reports that no local validator can decide, because they depend
 * on NAV's own records. Documented so the coverage of this module is honest.
 */
export const LOCALLY_UNDECIDABLE = [
  'INVOICE_NUMBER_NOT_UNIQUE',
  'INVALID_INVOICE_REFERENCE',
  'INVALID_ANNULMENT_REFERENCE',
  'MULTIPLE_INVOICES_FOUND',
  'MODIFICATION_INDEX_NOT_UNIQUE',
  'MODIFY_WITHOUT_MASTER_MISMATCH',
  'INVOICE_TYPE_MISMATCH',
  'INVOICE_LINE_ALREADY_EXISTS',
  'ANNULMENT_IN_PROGRESS',
  'CUSTOMER_NOT_ASSIGNED',
  'INCORRECT_HEAD_DATA_CUSTOMER_TAX_NUMBER',
] as const;

export function collectBusinessIssues(
  document: InvoiceData,
  collector: IssueCollector,
  context: InvoiceValidationContext = {},
): void {
  checkDocument(document, collector, context);

  const single = document.invoiceMain.invoice;
  if (single) {
    checkInvoice(single, '', collector, context);
    return;
  }

  const batch = document.invoiceMain.batchInvoice ?? [];
  // A batch modification document exists to amend several invoices at once;
  // one entry means it should have been a plain modification.
  if (batch.length === 1) {
    collector.error(
      'BATCH_INVOICE_CARDINALITY_ERROR',
      'invoiceMain.batchInvoice',
      'a batch document must amend at least two invoices, found 1',
    );
  }
  let previous = 0;
  for (const [position, entry] of batch.entries()) {
    if (entry.batchIndex <= previous) {
      collector.error(
        'BATCH_INDEX_NOT_SEQUENTIAL',
        `invoiceMain.batchInvoice.${position}.batchIndex`,
        `must be strictly ascending, ${entry.batchIndex} follows ${previous}`,
      );
    }
    previous = entry.batchIndex;
    checkInvoice(entry.invoice, `invoiceMain.batchInvoice.${position}.`, collector, context);
  }
}

function checkDocument(
  document: InvoiceData,
  collector: IssueCollector,
  context: InvoiceValidationContext,
): void {
  const today = context.today ?? new Date().toISOString().slice(0, 10);
  if (document.invoiceIssueDate > today) {
    collector.error(
      'INCORRECT_DATE_INVOICE_ISSUE_DATE_LATE',
      'invoiceIssueDate',
      `is in the future: ${document.invoiceIssueDate} (today is ${today})`,
    );
  }

  // completenessIndicator asserts that the report *is* the invoice, which only
  // makes sense for an invoice that exists in electronic form.
  if (document.completenessIndicator) {
    const appearance = document.invoiceMain.invoice?.invoiceHead.invoiceDetail.invoiceAppearance;
    if (appearance !== undefined && appearance !== 'ELECTRONIC') {
      collector.error(
        'INVOICE_COMPLETENESS_NOT_ALLOWED',
        'completenessIndicator',
        `is set, which requires invoiceAppearance ELECTRONIC, but it is ${appearance}`,
      );
    }
    if (document.invoiceMain.batchInvoice !== undefined) {
      collector.error(
        'INVOICE_COMPLETENESS_NOT_ALLOWED',
        'completenessIndicator',
        'cannot be set on a batch document',
      );
    }
  }
}

function checkInvoice(
  invoice: InvoiceType,
  prefix: string,
  collector: IssueCollector,
  context: InvoiceValidationContext,
): void {
  const at = (path: string): string => `${prefix}${path}`;
  const head = invoice.invoiceHead;
  const detail = head.invoiceDetail;
  const lines = invoice.invoiceLines?.line ?? [];
  const isModification = context.operation === 'MODIFY' || context.operation === 'STORNO';

  // --- references -------------------------------------------------------
  if (isModification && invoice.invoiceReference === undefined) {
    collector.error(
      'INVOICE_REFERENCE_EXPECTED',
      at('invoiceReference'),
      `is required for a ${context.operation} operation`,
    );
  }
  if (context.operation === 'CREATE' && invoice.invoiceReference !== undefined) {
    collector.error(
      'INVOICE_REFERENCE_NOT_EXPECTED',
      at('invoiceReference'),
      'an original invoice must not reference another document',
    );
  }

  // --- parties ----------------------------------------------------------
  const supplierId = head.supplierInfo.supplierTaxNumber.taxpayerId;
  if (context.supplierTaxNumber !== undefined && supplierId !== context.supplierTaxNumber) {
    collector.error(
      'SUPPLIER_TAX_NUMBER_MISMATCH',
      at('invoiceHead.supplierInfo.supplierTaxNumber.taxpayerId'),
      `is ${supplierId} but the request authenticates as ${context.supplierTaxNumber}`,
    );
  }
  checkTaxNumber(
    supplierId,
    head.supplierInfo.supplierTaxNumber.countyCode,
    at('invoiceHead.supplierInfo.supplierTaxNumber'),
    collector,
  );

  const customer = head.customerInfo;
  const customerId = customer?.customerVatData?.customerTaxNumber?.taxpayerId;
  if (customer) {
    checkCustomer(customer, at('invoiceHead.customerInfo'), collector);
  }
  if (customerId !== undefined && customerId === supplierId) {
    collector.error(
      'SUPPLIER_CUSTOMER_MATCH_TAXPAYER',
      at('invoiceHead.customerInfo'),
      `the customer's tax number ${customerId} is the supplier's own`,
    );
  }

  // --- dates ------------------------------------------------------------
  if (
    detail.invoiceDeliveryPeriodStart !== undefined &&
    detail.invoiceDeliveryPeriodEnd !== undefined &&
    detail.invoiceDeliveryPeriodStart > detail.invoiceDeliveryPeriodEnd
  ) {
    collector.error(
      'INCORRECT_DATE_INVOICE_DELIVERY_TO_FROM',
      at('invoiceHead.invoiceDetail.invoiceDeliveryPeriodStart'),
      `${detail.invoiceDeliveryPeriodStart} is after the period end ${detail.invoiceDeliveryPeriodEnd}`,
    );
  }

  // --- lines ------------------------------------------------------------
  if (lines.length === 0 && context.operation === 'CREATE') {
    collector.error('INVOICE_LINE_MISSING', at('invoiceLines'), 'an invoice must have lines');
  }

  let previousLineNumber = 0;
  for (const [position, line] of lines.entries()) {
    const linePath = at(`invoiceLines.line.${position}`);
    if (line.lineNumber <= previousLineNumber) {
      collector.error(
        'LINE_NUMBER_NOT_SEQUENTIAL',
        `${linePath}.lineNumber`,
        `must be strictly ascending, ${line.lineNumber} follows ${previousLineNumber}`,
      );
    }
    previousLineNumber = line.lineNumber;
    checkLine(line, linePath, detail.exchangeRate, collector, context);
  }

  // --- line and summary must describe the same kind of invoice ----------
  checkLineSummaryConsistency(lines, invoice.invoiceSummary, at(''), collector);

  // --- arithmetic -------------------------------------------------------
  if (hasAmountBearingLines(invoice)) {
    for (const issue of checkInvoiceSummary(invoice)) {
      collector.error(summaryFaultCode(issue.path), at(issue.path), issue.message);
    }
  }
}

/** Map a summary path to the closest NAV fault code. */
function summaryFaultCode(
  path: string,
):
  | 'INCORRECT_SUMMARY_CALCULATION_INVOICE_NET_AMOUNT'
  | 'INCORRECT_SUMMARY_CALCULATION_INVOICE_VAT_AMOUNT'
  | 'INCORRECT_SUMMARY_CALCULATION_INVOICE_GROSS_AMOUNT'
  | 'INCORRECT_SUMMARY_CALCULATION_VAT_RATE_NET_AMOUNT_SUMMARY'
  | 'INCORRECT_SUMMARY_CALCULATION_VAT_RATE_VAT_AMOUNT_SUMMARY' {
  if (path.includes('vatRateNetData')) {
    return 'INCORRECT_SUMMARY_CALCULATION_VAT_RATE_NET_AMOUNT_SUMMARY';
  }
  if (path.includes('vatRateVatData')) {
    return 'INCORRECT_SUMMARY_CALCULATION_VAT_RATE_VAT_AMOUNT_SUMMARY';
  }
  if (path.includes('GrossAmount')) return 'INCORRECT_SUMMARY_CALCULATION_INVOICE_GROSS_AMOUNT';
  if (path.includes('VatAmount')) return 'INCORRECT_SUMMARY_CALCULATION_INVOICE_VAT_AMOUNT';
  return 'INCORRECT_SUMMARY_CALCULATION_INVOICE_NET_AMOUNT';
}

function checkCustomer(
  customer: NonNullable<InvoiceType['invoiceHead']['customerInfo']>,
  path: string,
  collector: IssueCollector,
): void {
  const status = customer.customerVatStatus;
  const vatData = customer.customerVatData;

  if (status === 'DOMESTIC') {
    if (vatData?.customerTaxNumber === undefined) {
      collector.error(
        'MISSING_CUSTOMER_DOMESTIC_TAXNUMBER',
        `${path}.customerVatData.customerTaxNumber`,
        'a domestic customer must be identified by a Hungarian tax number',
      );
    }
    if (vatData?.communityVatNumber !== undefined) {
      collector.error(
        'CUSTOMER_COMMUNITY_TAXNUMBER_NOT_EXPECTED',
        `${path}.customerVatData.communityVatNumber`,
        'must not be supplied for a domestic customer',
      );
    }
    if (vatData?.thirdStateTaxId !== undefined) {
      collector.error(
        'CUSTOMER_THIRD_STATE_TAXNUMBER_NOT_EXPECTED',
        `${path}.customerVatData.thirdStateTaxId`,
        'must not be supplied for a domestic customer',
      );
    }
  }

  if (status === 'PRIVATE_PERSON' && vatData !== undefined) {
    // NAV's own private-person sample carries nothing but the status: no VAT
    // data, no name, no address.
    collector.error(
      'CUSTOMER_DATA_NOT_EXPECTED',
      `${path}.customerVatData`,
      'must not be supplied for a private person',
    );
  }

  const taxNumber = vatData?.customerTaxNumber;
  if (taxNumber) {
    checkTaxNumber(
      taxNumber.taxpayerId,
      taxNumber.countyCode,
      `${path}.customerVatData.customerTaxNumber`,
      collector,
    );
  }
}

function checkTaxNumber(
  taxpayerId: string,
  countyCode: string | undefined,
  path: string,
  collector: IssueCollector,
): void {
  // A warning, not an error: NAV validates a tax number against its taxpayer
  // registry rather than arithmetically, and two of the tax numbers in its own
  // samples fail this check. Use queryTaxpayer for an authoritative answer.
  if (!isValidTaxpayerId(taxpayerId)) {
    collector.warn(
      'LOCAL_TAXPAYER_ID_CHECK_DIGIT',
      `${path}.taxpayerId`,
      `${taxpayerId} fails the check digit; verify it with queryTaxpayer`,
    );
  }
  if (countyCode !== undefined && !isValidCountyCode(countyCode)) {
    collector.warn(
      'LOCAL_COUNTY_CODE_UNKNOWN',
      `${path}.countyCode`,
      `${countyCode} is not a county code NAV is known to issue`,
    );
  }
}

function checkLine(
  line: LineType,
  path: string,
  exchangeRate: string | undefined,
  collector: IssueCollector,
  context: InvoiceValidationContext,
): void {
  const isModification = context.operation === 'MODIFY' || context.operation === 'STORNO';

  if (context.operation === 'CREATE' && line.lineModificationReference !== undefined) {
    collector.error(
      'LINE_MODIFICATION_NOT_EXPECTED',
      `${path}.lineModificationReference`,
      'an original invoice line must not reference a modification',
    );
  }
  if (isModification && line.lineModificationReference === undefined) {
    collector.error(
      'LINE_MODIFICATION_EXPECTED',
      `${path}.lineModificationReference`,
      `is required on every line of a ${context.operation} document`,
    );
  }

  if (line.referencesToOtherLines?.referenceToOtherLine.includes(line.lineNumber)) {
    collector.error(
      'INCORRECT_LINE_DATA_SELF_LINE_NUMBER',
      `${path}.referencesToOtherLines`,
      `line ${line.lineNumber} references itself`,
    );
  }

  if (line.lineExpressionIndicator && line.quantity === undefined) {
    collector.error(
      'MISSING_LINE_DATA_QUANTITY',
      `${path}.quantity`,
      'is required when lineExpressionIndicator is set',
    );
  }

  if (line.unitOfMeasure === 'OWN' && line.unitOfMeasureOwn === undefined) {
    collector.error(
      'INCORRECT_LINE_DATA_UOM_INCOMPLETE',
      `${path}.unitOfMeasureOwn`,
      'is required when unitOfMeasure is OWN',
    );
  }
  if (line.unitOfMeasure !== 'OWN' && line.unitOfMeasureOwn !== undefined) {
    collector.error(
      'INCORRECT_LINE_DATA_UOM',
      `${path}.unitOfMeasureOwn`,
      'may only be supplied when unitOfMeasure is OWN',
    );
  }

  for (const [index, productCode] of (line.productCodes?.productCode ?? []).entries()) {
    const codePath = `${path}.productCodes.productCode.${index}`;
    // NAV's rule runs one way only: productCodeOwnValue belongs to an OWN
    // category. An OWN category may still carry an ordinary productCodeValue,
    // as NAV's own simplified-invoice sample does — requiring the own-value
    // field for every OWN category would reject eight of its thirty samples.
    if (
      productCode.productCodeOwnValue !== undefined &&
      productCode.productCodeCategory !== 'OWN'
    ) {
      collector.error(
        'INCORRECT_PRODUCT_CODE_VALUE_OWN',
        `${codePath}.productCodeOwnValue`,
        `may only be supplied when productCodeCategory is OWN, but it is ${productCode.productCodeCategory}`,
      );
    }
  }

  const normal = line.lineAmountsNormal;
  const simplified = line.lineAmountsSimplified;

  if (normal) {
    if (normal.lineVatRate.vatContent !== undefined) {
      collector.error(
        'INVALID_LINE_VAT_RATE_NORMAL',
        `${path}.lineAmountsNormal.lineVatRate.vatContent`,
        'VAT content may only be used on a simplified invoice line',
      );
    }
    checkNormalLineAmounts(line, normal, path, exchangeRate, collector);
  }

  if (simplified && simplified.lineVatRate.vatPercentage !== undefined) {
    collector.error(
      'INVALID_LINE_VAT_RATE_SIMPLIFIED',
      `${path}.lineAmountsSimplified.lineVatRate.vatPercentage`,
      'a simplified invoice line states VAT content, not a VAT percentage',
    );
  }

  const percentage = normal?.lineVatRate.vatPercentage;
  if (
    percentage !== undefined &&
    !KNOWN_VAT_RATES.some((rate) => Decimal.from(rate).equals(percentage))
  ) {
    collector.warn(
      'LOCAL_VAT_PERCENTAGE_UNUSUAL',
      `${path}.lineAmountsNormal.lineVatRate.vatPercentage`,
      `${percentage} is not a current Hungarian VAT rate (${KNOWN_VAT_RATES.join(', ')})`,
    );
  }
}

function checkNormalLineAmounts(
  line: LineType,
  normal: NonNullable<LineType['lineAmountsNormal']>,
  path: string,
  exchangeRate: string | undefined,
  collector: IssueCollector,
): void {
  const net = Decimal.from(normal.lineNetAmountData.lineNetAmount);
  const vat = normal.lineVatData ? Decimal.from(normal.lineVatData.lineVatAmount) : undefined;

  // net = quantity x unit price, unless a line discount was applied.
  if (
    line.lineExpressionIndicator &&
    line.quantity !== undefined &&
    line.unitPrice !== undefined &&
    line.lineDiscountData === undefined
  ) {
    const expected = Decimal.from(line.quantity).multiply(line.unitPrice).round(net.scale);
    if (!expected.equals(net)) {
      collector.error(
        'INCORRECT_LINE_CALCULATION_NET_AMOUNT',
        `${path}.lineAmountsNormal.lineNetAmountData.lineNetAmount`,
        `is ${net.toString()} but quantity ${line.quantity} times unit price ${line.unitPrice} is ${expected.toString()}`,
      );
    }
  }

  // gross = net + VAT
  const gross = normal.lineGrossAmountData?.lineGrossAmountNormal;
  if (gross !== undefined && vat !== undefined) {
    const expected = net.add(vat);
    if (!expected.equals(gross)) {
      collector.error(
        'INCORRECT_LINE_CALCULATION_GROSS_AMOUNT',
        `${path}.lineAmountsNormal.lineGrossAmountData.lineGrossAmountNormal`,
        `is ${gross} but net ${net.toString()} plus VAT ${vat.toString()} is ${expected.toString()}`,
      );
    }
  }

  // Forint equivalents follow from the exchange rate.
  if (exchangeRate !== undefined) {
    const rate = Decimal.from(exchangeRate);
    const netHuf = Decimal.from(normal.lineNetAmountData.lineNetAmountHUF);
    const expectedNetHuf = net.multiply(rate).round(netHuf.scale);
    if (!expectedNetHuf.equals(netHuf)) {
      collector.error(
        'INCORRECT_LINE_CALCULATION_LINE_NET_AMOUNT_HUF',
        `${path}.lineAmountsNormal.lineNetAmountData.lineNetAmountHUF`,
        `is ${netHuf.toString()} but ${net.toString()} at ${exchangeRate} is ${expectedNetHuf.toString()}`,
      );
    }
  }
}

/**
 * A normal invoice needs normal line amounts and a normal summary; a
 * simplified one needs the simplified forms. Mixing them is the mistake NAV
 * reports as a LINE_SUMMARY_TYPE_MISMATCH.
 */
function checkLineSummaryConsistency(
  lines: LineType[],
  summary: SummaryType,
  prefix: string,
  collector: IssueCollector,
): void {
  const hasNormalLines = lines.some((line) => line.lineAmountsNormal !== undefined);
  const hasSimplifiedLines = lines.some((line) => line.lineAmountsSimplified !== undefined);

  if (hasSimplifiedLines && summary.summaryNormal !== undefined) {
    collector.error(
      'LINE_SUMMARY_TYPE_MISMATCH_SUMMARY_NORMAL',
      `${prefix}invoiceSummary.summaryNormal`,
      'the invoice has simplified lines, so the summary must be simplified too',
    );
  }
  if (hasNormalLines && summary.summarySimplified !== undefined) {
    collector.error(
      'LINE_SUMMARY_TYPE_MISMATCH_SUMMARY_SIMPLIFIED',
      `${prefix}invoiceSummary.summarySimplified`,
      'the invoice has normal lines, so the summary must be normal too',
    );
  }
  if (hasNormalLines && hasSimplifiedLines) {
    collector.error(
      'LINE_SUMMARY_TYPE_MISMATCH_LINE_NORMAL',
      `${prefix}invoiceLines`,
      'an invoice cannot mix normal and simplified line amounts',
    );
  }
}
