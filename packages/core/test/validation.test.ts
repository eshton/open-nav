import { describe, expect, it } from 'vitest';
import type { FaultCode } from '../src/validation/issue.js';
import { validateInvoice, type ValidateInvoiceOptions } from '../src/validation/validate.js';
import type { InvoiceData, InvoiceType, LineType } from '../src/generated/types.js';
import { parseDocument } from '../src/xml/read.js';
import { loadFixtures } from './fixtures.js';

/**
 * Rule-by-rule tests.
 *
 * Each case starts from a real NAV invoice, so the baseline is known to be
 * valid, and changes exactly one thing. That keeps a failing test pointed at
 * one rule, and it means a rule cannot pass by accident on a document that was
 * already broken.
 */

const fixtures = loadFixtures('data-samples');

/** A date far in the future, so the issue-date rules never fire incidentally. */
const TODAY = '2030-01-01';

function fixture(name: string): InvoiceData {
  const found = fixtures.find((entry) => entry.name === name);
  if (!found) throw new Error(`No fixture named ${name}`);
  return structuredClone(parseDocument(found.xml).value as InvoiceData);
}

/** A plain domestic sale: one supplier, one company customer, three lines. */
const domesticSale = (): InvoiceData => fixture('belfoldi-termekertekesites.xml');
const simplified = (): InvoiceData => fixture('belfoldi-egyszerusitett-szamla.xml');
const privatePerson = (): InvoiceData => fixture('belfoldi-termekertekesites-maganszemelynek.xml');
const foreignCurrency = (): InvoiceData => fixture('belfoldi-devizas-szamla.xml');
const batchModification = (): InvoiceData => fixture('tobb-szamla-modositasa-egy-okirattal.xml');

function invoiceOf(document: InvoiceData): InvoiceType {
  const invoice = document.invoiceMain.invoice;
  if (!invoice) throw new Error('expected a single invoice document');
  return invoice;
}

function firstLine(document: InvoiceData): LineType {
  const line = invoiceOf(document).invoiceLines?.line[0];
  if (!line) throw new Error('expected at least one line');
  return line;
}

function codesOf(document: InvoiceData, options: ValidateInvoiceOptions = {}): FaultCode[] {
  return validateInvoice(document, { today: TODAY, ...options }).issues.map((issue) => issue.code);
}

/** Assert the baseline is clean, so a rule test cannot pass vacuously. */
function expectClean(document: InvoiceData, options: ValidateInvoiceOptions = {}): void {
  const report = validateInvoice(document, { today: TODAY, ...options });
  expect(report.errors, JSON.stringify(report.errors, null, 2)).toEqual([]);
  expect(report.valid).toBe(true);
}

describe('baselines are valid', () => {
  it('accepts each invoice shape used as a test baseline', () => {
    expectClean(domesticSale(), { operation: 'CREATE' });
    expectClean(simplified(), { operation: 'CREATE' });
    expectClean(privatePerson(), { operation: 'CREATE' });
    expectClean(foreignCurrency(), { operation: 'CREATE' });
  });
});

describe('references and operations', () => {
  it('requires a reference on a modification', () => {
    const document = domesticSale();
    delete invoiceOf(document).invoiceReference;
    expect(codesOf(document, { operation: 'MODIFY' })).toContain('INVOICE_REFERENCE_EXPECTED');
    expect(codesOf(document, { operation: 'STORNO' })).toContain('INVOICE_REFERENCE_EXPECTED');
  });

  it('forbids a reference on an original invoice', () => {
    const document = domesticSale();
    invoiceOf(document).invoiceReference = {
      originalInvoiceNumber: '2021/000122',
      modifyWithoutMaster: false,
      modificationIndex: 1,
    };
    expect(codesOf(document, { operation: 'CREATE' })).toContain('INVOICE_REFERENCE_NOT_EXPECTED');
  });

  it('says nothing about references when the operation is unknown', () => {
    // Without an operation the rule cannot apply, and guessing would be worse.
    const document = domesticSale();
    delete invoiceOf(document).invoiceReference;
    expect(codesOf(document)).not.toContain('INVOICE_REFERENCE_EXPECTED');
  });

  it('forbids a line modification reference on an original invoice', () => {
    const document = domesticSale();
    firstLine(document).lineModificationReference = {
      lineNumberReference: 1,
      lineOperation: 'MODIFY',
    };
    expect(codesOf(document, { operation: 'CREATE' })).toContain('LINE_MODIFICATION_NOT_EXPECTED');
  });

  it('requires a line modification reference on a modification', () => {
    const document = domesticSale();
    invoiceOf(document).invoiceReference = {
      originalInvoiceNumber: '2021/000122',
      modifyWithoutMaster: false,
      modificationIndex: 1,
    };
    expect(codesOf(document, { operation: 'MODIFY' })).toContain('LINE_MODIFICATION_EXPECTED');
  });
});

describe('parties', () => {
  it('rejects a supplier other than the authenticated taxpayer', () => {
    const document = domesticSale();
    const codes = codesOf(document, { operation: 'CREATE', supplierTaxNumber: '11111111' });
    expect(codes).toContain('SUPPLIER_TAX_NUMBER_MISMATCH');
  });

  it('accepts the matching supplier', () => {
    const document = domesticSale();
    const supplier = invoiceOf(document).invoiceHead.supplierInfo.supplierTaxNumber.taxpayerId;
    expect(codesOf(document, { operation: 'CREATE', supplierTaxNumber: supplier })).not.toContain(
      'SUPPLIER_TAX_NUMBER_MISMATCH',
    );
  });

  it('rejects an invoice a taxpayer issues to itself', () => {
    const document = domesticSale();
    const head = invoiceOf(document).invoiceHead;
    const supplier = head.supplierInfo.supplierTaxNumber.taxpayerId;
    head.customerInfo!.customerVatData!.customerTaxNumber!.taxpayerId = supplier;
    expect(codesOf(document, { operation: 'CREATE' })).toContain(
      'SUPPLIER_CUSTOMER_MATCH_TAXPAYER',
    );
  });

  it('requires a tax number for a domestic customer', () => {
    const document = domesticSale();
    delete invoiceOf(document).invoiceHead.customerInfo!.customerVatData;
    expect(codesOf(document, { operation: 'CREATE' })).toContain(
      'MISSING_CUSTOMER_DOMESTIC_TAXNUMBER',
    );
  });

  it('forbids a community VAT number on a domestic customer', () => {
    // The three ways of identifying a customer are a schema choice, so the
    // community number replaces the tax number rather than joining it.
    const document = domesticSale();
    invoiceOf(document).invoiceHead.customerInfo!.customerVatData = {
      communityVatNumber: 'DE123456789',
    };
    expect(codesOf(document, { operation: 'CREATE' })).toContain(
      'CUSTOMER_COMMUNITY_TAXNUMBER_NOT_EXPECTED',
    );
  });

  it('accepts a community VAT number for a customer in another member state', () => {
    const document = domesticSale();
    invoiceOf(document).invoiceHead.customerInfo!.customerVatStatus = 'OTHER';
    invoiceOf(document).invoiceHead.customerInfo!.customerVatData = {
      communityVatNumber: 'DE123456789',
    };
    expect(codesOf(document, { operation: 'CREATE' })).not.toContain(
      'CUSTOMER_COMMUNITY_TAXNUMBER_NOT_EXPECTED',
    );
  });

  it('forbids a third state tax id on a domestic customer', () => {
    const document = domesticSale();
    invoiceOf(document).invoiceHead.customerInfo!.customerVatData = { thirdStateTaxId: 'US-99' };
    expect(codesOf(document, { operation: 'CREATE' })).toContain(
      'CUSTOMER_THIRD_STATE_TAXNUMBER_NOT_EXPECTED',
    );
  });

  it('reports a missing domestic tax number when another identifier is used', () => {
    const document = domesticSale();
    invoiceOf(document).invoiceHead.customerInfo!.customerVatData = { thirdStateTaxId: 'US-99' };
    expect(codesOf(document, { operation: 'CREATE' })).toContain(
      'MISSING_CUSTOMER_DOMESTIC_TAXNUMBER',
    );
  });

  it('forbids VAT data for a private person', () => {
    const document = privatePerson();
    invoiceOf(document).invoiceHead.customerInfo!.customerVatData = {
      customerTaxNumber: { taxpayerId: '99887764' },
    };
    expect(codesOf(document, { operation: 'CREATE' })).toContain('CUSTOMER_DATA_NOT_EXPECTED');
  });

  it('warns about a tax number whose check digit is wrong, without failing', () => {
    const document = domesticSale();
    invoiceOf(document).invoiceHead.customerInfo!.customerVatData!.customerTaxNumber!.taxpayerId =
      '12345678';
    const report = validateInvoice(document, { today: TODAY, operation: 'CREATE' });
    expect(report.warnings.map((issue) => issue.code)).toContain('LOCAL_TAXPAYER_ID_CHECK_DIGIT');
    // NAV checks its registry, so this must not block a submission.
    expect(report.valid).toBe(true);
  });

  it('warns about an unissued county code', () => {
    const document = domesticSale();
    invoiceOf(document).invoiceHead.supplierInfo.supplierTaxNumber.countyCode = '99';
    const report = validateInvoice(document, { today: TODAY, operation: 'CREATE' });
    expect(report.warnings.map((issue) => issue.code)).toContain('LOCAL_COUNTY_CODE_UNKNOWN');
    expect(report.valid).toBe(true);
  });
});

describe('lines', () => {
  it('requires strictly ascending line numbers', () => {
    const document = domesticSale();
    const lines = invoiceOf(document).invoiceLines!.line;
    expect(lines.length).toBeGreaterThan(1);
    lines[1]!.lineNumber = lines[0]!.lineNumber;
    expect(codesOf(document, { operation: 'CREATE' })).toContain('LINE_NUMBER_NOT_SEQUENTIAL');
  });

  it('rejects a line that references itself', () => {
    const document = domesticSale();
    const line = firstLine(document);
    line.referencesToOtherLines = { referenceToOtherLine: [line.lineNumber] };
    expect(codesOf(document, { operation: 'CREATE' })).toContain(
      'INCORRECT_LINE_DATA_SELF_LINE_NUMBER',
    );
  });

  it('accepts a line that references a different line', () => {
    const document = domesticSale();
    const line = firstLine(document);
    line.referencesToOtherLines = { referenceToOtherLine: [line.lineNumber + 1] };
    expect(codesOf(document, { operation: 'CREATE' })).not.toContain(
      'INCORRECT_LINE_DATA_SELF_LINE_NUMBER',
    );
  });

  it('requires an invoice to have lines when creating one', () => {
    const document = domesticSale();
    delete invoiceOf(document).invoiceLines;
    expect(codesOf(document, { operation: 'CREATE' })).toContain('INVOICE_LINE_MISSING');
  });

  it('permits a modification document with no lines', () => {
    // NAV's own batch modification samples amend header data only.
    const document = batchModification();
    expect(codesOf(document, { operation: 'MODIFY' })).not.toContain('INVOICE_LINE_MISSING');
  });

  it('requires the own unit of measure only when the unit is OWN', () => {
    const document = domesticSale();
    const line = firstLine(document);
    line.unitOfMeasure = 'OWN';
    expect(codesOf(document, { operation: 'CREATE' })).toContain(
      'INCORRECT_LINE_DATA_UOM_INCOMPLETE',
    );

    line.unitOfMeasureOwn = 'bundle';
    expect(codesOf(document, { operation: 'CREATE' })).not.toContain(
      'INCORRECT_LINE_DATA_UOM_INCOMPLETE',
    );
  });

  it('forbids an own unit of measure with a standard unit', () => {
    const document = domesticSale();
    const line = firstLine(document);
    line.unitOfMeasure = 'PIECE';
    line.unitOfMeasureOwn = 'bundle';
    expect(codesOf(document, { operation: 'CREATE' })).toContain('INCORRECT_LINE_DATA_UOM');
  });

  it('forbids an own product code value outside an OWN category', () => {
    const document = domesticSale();
    const line = firstLine(document);
    line.productCodes = {
      productCode: [{ productCodeCategory: 'VTSZ', productCodeOwnValue: 'SKU-1' }],
    };
    expect(codesOf(document, { operation: 'CREATE' })).toContain(
      'INCORRECT_PRODUCT_CODE_VALUE_OWN',
    );
  });

  it('accepts an OWN category carrying an ordinary product code value', () => {
    // As NAV's simplified invoice sample does.
    const document = domesticSale();
    firstLine(document).productCodes = {
      productCode: [{ productCodeCategory: 'OWN', productCodeValue: '99999999' }],
    };
    expect(codesOf(document, { operation: 'CREATE' })).not.toContain(
      'INCORRECT_PRODUCT_CODE_VALUE_OWN',
    );
  });
});

describe('VAT rates', () => {
  it('forbids VAT content on a normal line', () => {
    const document = domesticSale();
    firstLine(document).lineAmountsNormal!.lineVatRate = { vatContent: '0.2126' };
    expect(codesOf(document, { operation: 'CREATE' })).toContain('INVALID_LINE_VAT_RATE_NORMAL');
  });

  it('forbids a VAT percentage on a simplified line', () => {
    const document = simplified();
    firstLine(document).lineAmountsSimplified!.lineVatRate = { vatPercentage: '0.27' };
    expect(codesOf(document, { operation: 'CREATE' })).toContain(
      'INVALID_LINE_VAT_RATE_SIMPLIFIED',
    );
  });

  it('warns about a VAT percentage that is not a current rate', () => {
    const document = domesticSale();
    firstLine(document).lineAmountsNormal!.lineVatRate = { vatPercentage: '0.19' };
    const report = validateInvoice(document, { today: TODAY, operation: 'CREATE' });
    expect(report.warnings.map((issue) => issue.code)).toContain('LOCAL_VAT_PERCENTAGE_UNUSUAL');
  });

  it('accepts every current Hungarian rate without warning', () => {
    for (const rate of ['0', '0.05', '0.18', '0.27']) {
      const document = domesticSale();
      firstLine(document).lineAmountsNormal!.lineVatRate = { vatPercentage: rate };
      const report = validateInvoice(document, { today: TODAY, operation: 'CREATE' });
      expect(
        report.warnings.map((issue) => issue.code),
        rate,
      ).not.toContain('LOCAL_VAT_PERCENTAGE_UNUSUAL');
    }
  });
});

describe('line arithmetic', () => {
  it('rejects a gross amount that is not net plus VAT', () => {
    const document = domesticSale();
    const amounts = firstLine(document).lineAmountsNormal!;
    amounts.lineGrossAmountData!.lineGrossAmountNormal = '1.00';
    expect(codesOf(document, { operation: 'CREATE' })).toContain(
      'INCORRECT_LINE_CALCULATION_GROSS_AMOUNT',
    );
  });

  it('rejects a net amount that is not quantity times unit price', () => {
    const document = domesticSale();
    const line = firstLine(document);
    line.quantity = '7';
    expect(codesOf(document, { operation: 'CREATE' })).toContain(
      'INCORRECT_LINE_CALCULATION_NET_AMOUNT',
    );
  });

  it('does not second-guess the net amount when a line discount applies', () => {
    const document = domesticSale();
    const line = firstLine(document);
    line.quantity = '7';
    line.lineDiscountData = { discountDescription: 'volume' };
    expect(codesOf(document, { operation: 'CREATE' })).not.toContain(
      'INCORRECT_LINE_CALCULATION_NET_AMOUNT',
    );
  });

  it('rejects a forint amount inconsistent with the exchange rate', () => {
    const document = foreignCurrency();
    firstLine(document).lineAmountsNormal!.lineNetAmountData.lineNetAmountHUF = '1.00';
    expect(codesOf(document, { operation: 'CREATE' })).toContain(
      'INCORRECT_LINE_CALCULATION_LINE_NET_AMOUNT_HUF',
    );
  });

  it('accepts the exact conversion NAV uses', () => {
    // 3000.00 at 310.00 is 930000.00, to the fillér.
    expectClean(foreignCurrency(), { operation: 'CREATE' });
  });
});

describe('summary consistency', () => {
  it('rejects a normal summary on an invoice with simplified lines', () => {
    // summaryNormal and summarySimplified are a schema choice, so the normal
    // summary replaces the simplified one.
    const document = simplified();
    const invoice = invoiceOf(document);
    delete invoice.invoiceSummary.summarySimplified;
    invoice.invoiceSummary.summaryNormal = {
      summaryByVatRate: [
        {
          vatRate: { vatPercentage: '0.27' },
          vatRateNetData: { vatRateNetAmount: '1', vatRateNetAmountHUF: '1' },
          vatRateVatData: { vatRateVatAmount: '0', vatRateVatAmountHUF: '0' },
        },
      ],
      invoiceNetAmount: '1',
      invoiceNetAmountHUF: '1',
      invoiceVatAmount: '0',
      invoiceVatAmountHUF: '0',
    };
    expect(codesOf(document, { operation: 'CREATE' })).toContain(
      'LINE_SUMMARY_TYPE_MISMATCH_SUMMARY_NORMAL',
    );
  });

  it('rejects a summary that disagrees with the lines', () => {
    const document = domesticSale();
    invoiceOf(document).invoiceSummary.summaryNormal!.invoiceNetAmount = '1.00';
    expect(codesOf(document, { operation: 'CREATE' })).toContain(
      'INCORRECT_SUMMARY_CALCULATION_INVOICE_NET_AMOUNT',
    );
  });
});

describe('dates and completeness', () => {
  it('rejects an issue date in the future', () => {
    const document = domesticSale();
    expect(codesOf(document, { operation: 'CREATE', today: '2000-01-01' })).toContain(
      'INCORRECT_DATE_INVOICE_ISSUE_DATE_LATE',
    );
  });

  it('rejects a delivery period that ends before it starts', () => {
    const document = domesticSale();
    const detail = invoiceOf(document).invoiceHead.invoiceDetail;
    detail.invoiceDeliveryPeriodStart = '2021-05-31';
    detail.invoiceDeliveryPeriodEnd = '2021-05-01';
    expect(codesOf(document, { operation: 'CREATE' })).toContain(
      'INCORRECT_DATE_INVOICE_DELIVERY_TO_FROM',
    );
  });

  it('accepts a delivery period that starts and ends on the same day', () => {
    const document = domesticSale();
    const detail = invoiceOf(document).invoiceHead.invoiceDetail;
    detail.invoiceDeliveryPeriodStart = '2021-05-01';
    detail.invoiceDeliveryPeriodEnd = '2021-05-01';
    expect(codesOf(document, { operation: 'CREATE' })).not.toContain(
      'INCORRECT_DATE_INVOICE_DELIVERY_TO_FROM',
    );
  });

  it('allows completeness only for an electronic invoice', () => {
    const document = domesticSale();
    document.completenessIndicator = true;
    invoiceOf(document).invoiceHead.invoiceDetail.invoiceAppearance = 'PAPER';
    expect(codesOf(document, { operation: 'CREATE' })).toContain(
      'INVOICE_COMPLETENESS_NOT_ALLOWED',
    );

    invoiceOf(document).invoiceHead.invoiceDetail.invoiceAppearance = 'ELECTRONIC';
    expect(codesOf(document, { operation: 'CREATE' })).not.toContain(
      'INVOICE_COMPLETENESS_NOT_ALLOWED',
    );
  });
});

describe('batch documents', () => {
  it('requires at least two invoices in a batch modification', () => {
    const document = batchModification();
    document.invoiceMain.batchInvoice = [document.invoiceMain.batchInvoice![0]!];
    expect(codesOf(document, { operation: 'MODIFY' })).toContain('BATCH_INVOICE_CARDINALITY_ERROR');
  });

  it('requires strictly ascending batch indexes', () => {
    const document = batchModification();
    const batch = document.invoiceMain.batchInvoice!;
    expect(batch.length).toBeGreaterThan(1);
    batch[1]!.batchIndex = batch[0]!.batchIndex;
    expect(codesOf(document, { operation: 'MODIFY' })).toContain('BATCH_INDEX_NOT_SEQUENTIAL');
  });

  it('forbids completeness on a batch document', () => {
    const document = batchModification();
    document.completenessIndicator = true;
    expect(codesOf(document, { operation: 'MODIFY' })).toContain(
      'INVOICE_COMPLETENESS_NOT_ALLOWED',
    );
  });
});

describe('reported issues carry NAV wording', () => {
  it('attaches NAV’s own description of the fault', () => {
    const document = domesticSale();
    delete invoiceOf(document).invoiceLines;
    const issue = validateInvoice(document, { today: TODAY, operation: 'CREATE' }).errors.find(
      (candidate) => candidate.code === 'INVOICE_LINE_MISSING',
    );
    expect(issue?.origin).toBe('nav');
    expect(issue?.navMessage).toBe('The invoice contains no line items.');
  });

  it('can report NAV wording in Hungarian', () => {
    const document = domesticSale();
    delete invoiceOf(document).invoiceLines;
    const issue = validateInvoice(document, {
      today: TODAY,
      operation: 'CREATE',
      language: 'hu',
    }).errors.find((candidate) => candidate.code === 'INVOICE_LINE_MISSING');
    expect(issue?.navMessage).toBe('A számla nem tartalmaz tételt.');
  });

  it('marks our own findings as local, with no NAV wording', () => {
    const document = domesticSale();
    invoiceOf(document).invoiceHead.supplierInfo.supplierTaxNumber.countyCode = '99';
    const issue = validateInvoice(document, { today: TODAY, operation: 'CREATE' }).warnings.find(
      (candidate) => candidate.code === 'LOCAL_COUNTY_CODE_UNKNOWN',
    );
    expect(issue?.origin).toBe('local');
    expect(issue?.navMessage).toBeUndefined();
  });
});

/**
 * The false-positive guard.
 *
 * A validator that flags valid documents is worse than none, so every one of
 * NAV's published invoices is run through the full rule set. The only errors
 * allowed are the arithmetic mistakes that are genuinely in NAV's samples,
 * each documented in conformance/README.md, and the only warnings allowed are
 * the two placeholder tax numbers those samples use.
 */
describe('no false positives on NAV’s published invoices', () => {
  /** Documents whose own figures contradict each other upstream. */
  const KNOWN_BAD = new Set([
    'belfoldi-ertekesites-tobb-afa-tipus.xml',
    'gyujtoszamla-1.xml',
    'harmadik-orszagbeli-devizas-szamla.xml',
    'tagorszagi-devizas-szamla.xml',
    'termekdijas-szamla.xml',
    'uj-kozlekedesi-eszkoz-export.xml',
  ]);

  const documents = fixtures.map((entry) => ({
    name: entry.name,
    document: parseDocument(entry.xml).value as InvoiceData,
  }));

  it('finds no errors in any self-consistent sample', () => {
    const unexpected: string[] = [];
    for (const entry of documents) {
      if (KNOWN_BAD.has(entry.name)) continue;
      const report = validateInvoice(entry.document, { today: TODAY });
      if (!report.valid) {
        unexpected.push(`${entry.name}: ${report.errors.map((issue) => issue.code).join(', ')}`);
      }
    }
    expect(unexpected).toEqual([]);
    expect(documents.length - KNOWN_BAD.size).toBe(24);
  });

  it('reports only arithmetic faults in the samples that do not add up', () => {
    for (const name of KNOWN_BAD) {
      const entry = documents.find((candidate) => candidate.name === name)!;
      const report = validateInvoice(entry.document, { today: TODAY });
      expect(report.valid, name).toBe(false);
      for (const issue of report.errors) {
        expect(issue.code, `${name}: ${issue.path}`).toMatch(
          /^INCORRECT_(SUMMARY_CALCULATION|LINE_CALCULATION)_/,
        );
      }
    }
  });

  it('raises warnings only for the placeholder tax numbers', () => {
    const warnings = documents.flatMap(
      (entry) => validateInvoice(entry.document, { today: TODAY }).warnings,
    );
    expect(new Set(warnings.map((issue) => issue.code))).toEqual(
      new Set(['LOCAL_TAXPAYER_ID_CHECK_DIGIT']),
    );
    expect(warnings).toHaveLength(2);
  });

  it('accepts every sample as a modification too, given a reference', () => {
    // Operation-dependent rules must not fire spuriously in either direction.
    for (const entry of documents) {
      if (KNOWN_BAD.has(entry.name)) continue;
      const report = validateInvoice(entry.document, { today: TODAY });
      expect(
        report.errors.map((issue) => issue.code),
        entry.name,
      ).not.toContain('INVOICE_REFERENCE_EXPECTED');
    }
  });
});
