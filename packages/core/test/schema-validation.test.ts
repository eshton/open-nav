import { describe, expect, it } from 'vitest';
import { IssueCollector } from '../src/validation/issue.js';
import { collectSchemaIssues } from '../src/validation/schema.js';
import { validateInvoice } from '../src/validation/validate.js';
import type { InvoiceData } from '../src/generated/types.js';
import { parseDocument } from '../src/xml/read.js';
import { loadFixtures } from './fixtures.js';

/**
 * Schema validation, driven by the generated descriptors.
 *
 * Every constraint checked here comes from NAV's XSDs, so these tests double
 * as a check that the generated facets survived codegen intact.
 */

const fixtures = loadFixtures('data-samples');
const apiFixtures = loadFixtures('api-samples');

function check(root: string, value: unknown) {
  const collector = new IssueCollector();
  collectSchemaIssues(root, value, collector);
  return collector.report();
}

function invoice(): InvoiceData {
  const found = fixtures.find((entry) => entry.name === 'belfoldi-termekertekesites.xml')!;
  return structuredClone(parseDocument(found.xml).value as InvoiceData);
}

describe('every official document satisfies the schema', () => {
  it('accepts all 30 invoice samples', () => {
    for (const fixture of fixtures) {
      const parsed = parseDocument(fixture.xml);
      const report = check(parsed.root, parsed.value);
      expect(report.issues, `${fixture.name}: ${JSON.stringify(report.issues)}`).toEqual([]);
    }
  });

  it('accepts all 11 API request samples', () => {
    for (const fixture of apiFixtures) {
      const parsed = parseDocument(fixture.xml);
      const report = check(parsed.root, parsed.value);
      expect(report.issues, `${fixture.name}: ${JSON.stringify(report.issues)}`).toEqual([]);
    }
  });
});

describe('mandatory content', () => {
  it('reports a missing required element', () => {
    const document = invoice();
    delete (document as Partial<InvoiceData>).invoiceNumber;
    const report = check('InvoiceData', document);
    expect(report.errors[0]).toMatchObject({
      code: 'MANDATORY_CONTENT_MISSING',
      path: 'invoiceNumber',
    });
  });

  it('reports a missing element nested deep in the document', () => {
    const document = invoice();
    delete (document.invoiceMain.invoice!.invoiceHead.supplierInfo as Record<string, unknown>)[
      'supplierName'
    ];
    const report = check('InvoiceData', document);
    expect(report.errors.map((issue) => issue.path)).toContain(
      'invoiceMain.invoice.invoiceHead.supplierInfo.supplierName',
    );
  });

  it('reports an empty array for a required repeated element', () => {
    const document = invoice();
    document.invoiceMain.invoice!.invoiceLines!.line = [];
    const report = check('InvoiceData', document);
    expect(report.errors.map((issue) => issue.code)).toContain('MANDATORY_CONTENT_MISSING');
  });

  it('accepts an absent optional element', () => {
    const document = invoice();
    delete document.invoiceMain.invoice!.invoiceHead.supplierInfo.supplierBankAccountNumber;
    expect(check('InvoiceData', document).issues).toEqual([]);
  });
});

describe('value constraints', () => {
  const cases: Array<{ name: string; mutate: (document: InvoiceData) => void; expect: RegExp }> = [
    {
      name: 'a pattern violation (tax number must be eight digits)',
      mutate: (document) => {
        document.invoiceMain.invoice!.invoiceHead.supplierInfo.supplierTaxNumber.taxpayerId =
          '1234567X';
      },
      expect: /does not match/,
    },
    {
      name: 'a value longer than maxLength',
      mutate: (document) => {
        document.invoiceMain.invoice!.invoiceHead.supplierInfo.supplierName = 'x'.repeat(600);
      },
      expect: /at most 512 characters/,
    },
    {
      name: 'a value that is not in an enumeration',
      mutate: (document) => {
        // @ts-expect-error deliberately outside the generated union
        document.invoiceMain.invoice!.invoiceHead.invoiceDetail.paymentMethod = 'BITCOIN';
      },
      expect: /is not one of TRANSFER, CASH, CARD, VOUCHER, OTHER/,
    },
    {
      name: 'a fixed-length field of the wrong length',
      mutate: (document) => {
        document.invoiceMain.invoice!.invoiceHead.invoiceDetail.currencyCode = 'HUFF';
      },
      expect: /exactly 3 characters/,
    },
    {
      name: 'too many decimal places for a monetary amount',
      mutate: (document) => {
        document.invoiceMain.invoice!.invoiceLines!.line[0]!.lineAmountsNormal!.lineNetAmountData.lineNetAmount =
          '100.12345';
      },
      expect: /has 5 decimal places, at most 2 allowed/,
    },
    {
      name: 'a rate above its maximum',
      mutate: (document) => {
        document.invoiceMain.invoice!.invoiceLines!.line[0]!.lineAmountsNormal!.lineVatRate = {
          vatPercentage: '1.5',
        };
      },
      expect: /must not be greater than 1/,
    },
    {
      name: 'a line number below its minimum',
      mutate: (document) => {
        document.invoiceMain.invoice!.invoiceLines!.line[0]!.lineNumber = 0;
      },
      expect: /must not be less than 1/,
    },
    {
      name: 'a date before the earliest NAV accepts',
      mutate: (document) => {
        document.invoiceIssueDate = '2009-12-31';
      },
      expect: /must not be less than 2010-01-01/,
    },
    {
      name: 'a boolean given as a string',
      mutate: (document) => {
        // @ts-expect-error deliberately the wrong type
        document.completenessIndicator = 'false';
      },
      expect: /expected a boolean/,
    },
    {
      name: 'an integer given as a decimal',
      mutate: (document) => {
        // @ts-expect-error deliberately the wrong type
        document.invoiceMain.invoice!.invoiceLines!.line[0]!.lineNumber = 1.5;
      },
      expect: /expected an integer/,
    },
    {
      name: 'a decimal that is not a number',
      mutate: (document) => {
        document.invoiceMain.invoice!.invoiceLines!.line[0]!.lineAmountsNormal!.lineNetAmountData.lineNetAmount =
          '1,00';
      },
      expect: /is not a decimal/,
    },
    {
      name: 'an element that is not in the schema',
      mutate: (document) => {
        (document as Record<string, unknown>)['madeUpField'] = 'x';
      },
      expect: /is not part of InvoiceData/,
    },
  ];

  for (const testCase of cases) {
    it(`reports ${testCase.name}`, () => {
      const document = invoice();
      testCase.mutate(document);
      const report = check('InvoiceData', document);
      expect(report.valid).toBe(false);
      expect(report.errors.map((issue) => issue.message).join(' | ')).toMatch(testCase.expect);
    });
  }
});

describe('choice groups', () => {
  it('rejects two members of a choice being set at once', () => {
    const document = invoice();
    document.invoiceMain.invoice!.invoiceLines!.line[0]!.lineAmountsNormal!.lineVatRate = {
      vatPercentage: '0.27',
      vatExemption: { case: 'AAM', reason: 'x' },
    };
    const report = check('InvoiceData', document);
    expect(report.errors.map((issue) => issue.message).join(' ')).toMatch(
      /only one of vatPercentage.*found vatPercentage and vatExemption/,
    );
  });

  it('rejects a required choice with no member set', () => {
    const document = invoice();
    document.invoiceMain.invoice!.invoiceLines!.line[0]!.lineAmountsNormal!.lineVatRate = {};
    const report = check('InvoiceData', document);
    expect(report.errors.map((issue) => issue.code)).toContain('MANDATORY_CONTENT_MISSING');
  });

  it('rejects both an invoice and a batch in one document', () => {
    const document = invoice();
    document.invoiceMain.batchInvoice = [{ batchIndex: 1, invoice: document.invoiceMain.invoice! }];
    const report = check('InvoiceData', document);
    expect(report.errors.map((issue) => issue.message).join(' ')).toMatch(
      /only one of invoice, batchInvoice/,
    );
  });

  it('accepts exactly one member of a choice', () => {
    const document = invoice();
    document.invoiceMain.invoice!.invoiceLines!.line[0]!.lineAmountsNormal!.lineVatRate = {
      vatExemption: { case: 'AAM', reason: 'alanyi adómentesség' },
    };
    // The VAT amount no longer follows from a rate, so only the summary
    // reconciliation should complain, never the schema.
    expect(check('InvoiceData', document).issues).toEqual([]);
  });
});

describe('validateInvoice layering', () => {
  it('stops at the schema when the document is structurally broken', () => {
    // Running business rules over a malformed document would produce noise.
    const document = invoice();
    delete (document as Partial<InvoiceData>).invoiceNumber;
    const report = validateInvoice(document, { operation: 'CREATE', today: '2030-01-01' });
    expect(report.errors.every((issue) => issue.code === 'MANDATORY_CONTENT_MISSING')).toBe(true);
  });

  it('can be asked for schema checks only', () => {
    const document = invoice();
    document.invoiceMain.invoice!.invoiceSummary.summaryNormal!.invoiceNetAmount = '1.00';
    expect(validateInvoice(document, { schemaOnly: true, today: '2030-01-01' }).valid).toBe(true);
    expect(validateInvoice(document, { today: '2030-01-01', operation: 'CREATE' }).valid).toBe(
      false,
    );
  });
});
