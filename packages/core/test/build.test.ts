import { describe, expect, it } from 'vitest';
import {
  buildInvoice,
  buildStorno,
  checkInvoiceSummary,
  parseDocument,
  serializeDocument,
  validateInvoice,
  type BuildInvoiceInput,
} from '../src/index.js';

const input: BuildInvoiceInput = {
  invoiceNumber: 'BUILD-2026-001',
  issueDate: '2026-03-01',
  paymentDate: '2026-03-15',
  paymentMethod: 'TRANSFER',
  supplier: {
    name: 'Teszt Szállító Kft',
    taxNumber: '11111111',
    bankAccount: '11111111-22222222-33333333',
    address: {
      postalCode: '1011',
      city: 'Budapest',
      streetName: 'Fő',
      publicPlaceCategory: 'utca',
      number: '1',
    },
  },
  customer: {
    name: 'Teszt Vevő Kft',
    taxNumber: '22222222',
    address: {
      postalCode: '7600',
      city: 'Pécs',
      streetName: 'Rákóczi',
      publicPlaceCategory: 'út',
      number: '2',
    },
  },
  lines: [
    { description: 'Widget', quantity: 10, unit: 'PIECE', unitPrice: 1000, vatPercentage: 0.27 },
    {
      description: 'Tanácsadás',
      quantity: 2,
      unitPrice: 5000,
      vatPercentage: 0.27,
      nature: 'SERVICE',
    },
  ],
};

describe('buildInvoice', () => {
  it('builds an invoice that passes validation with no errors', () => {
    const report = validateInvoice(buildInvoice(input), { operation: 'CREATE' });
    // Check-digit warnings on the placeholder tax numbers are fine; errors are not.
    expect(report.errors).toEqual([]);
    expect(report.valid).toBe(true);
  });

  it('computes line amounts and a summary that reconciles', () => {
    const invoice = buildInvoice(input).invoiceMain.invoice!;
    const first = invoice.invoiceLines!.line[0]!.lineAmountsNormal!;
    expect(first.lineNetAmountData.lineNetAmount).toBe('10000.00');
    expect(first.lineVatData!.lineVatAmount).toBe('2700.00');
    expect(first.lineGrossAmountData!.lineGrossAmountNormal).toBe('12700.00');

    // 10000 + 10000 net, 2700 + 2700 VAT.
    expect(invoice.invoiceSummary.summaryNormal?.invoiceNetAmount).toBe('20000.00');
    expect(invoice.invoiceSummary.summaryNormal?.invoiceVatAmount).toBe('5400.00');
    expect(invoice.invoiceSummary.summaryGrossData?.invoiceGrossAmount).toBe('25400.00');
    expect(checkInvoiceSummary(invoice)).toEqual([]);
  });

  it('survives a round trip through the XML', () => {
    const built = buildInvoice(input);
    const xml = serializeDocument('InvoiceData', built);
    const parsed = parseDocument(xml).value;
    expect(parsed).toEqual(built);
  });

  it('reports a private person as status only, with no identifying data', () => {
    const built = buildInvoice({
      ...input,
      customer: { name: 'Magánszemély', address: input.customer.address },
    });
    const customerInfo = built.invoiceMain.invoice!.invoiceHead.customerInfo!;
    // NAV forbids a private buyer's data; the builder must omit name/address/VAT.
    expect(customerInfo.customerVatStatus).toBe('PRIVATE_PERSON');
    expect(customerInfo.customerVatData).toBeUndefined();
    expect(customerInfo.customerName).toBeUndefined();
    expect(customerInfo.customerAddress).toBeUndefined();
    // ...and the result passes validation, no errors.
    expect(validateInvoice(built, { operation: 'CREATE' }).errors).toEqual([]);
  });

  it('validation rejects a private person carrying identifying data', () => {
    // A hand-built invoice that makes the mistake the builder now avoids.
    const built = buildInvoice(input);
    built.invoiceMain.invoice!.invoiceHead.customerInfo = {
      customerVatStatus: 'PRIVATE_PERSON',
      customerName: 'Nem megadható',
    } as never;
    const report = validateInvoice(built, { operation: 'CREATE' });
    expect(report.errors.some((issue) => issue.code === 'CUSTOMER_DATA_NOT_EXPECTED')).toBe(true);
  });

  it('rejects an invoice with no lines', () => {
    expect(() => buildInvoice({ ...input, lines: [] })).toThrowError(/at least one line/);
  });

  it('builds a storno that reverses amounts and references the original', () => {
    const original = buildInvoice(input);
    const storno = buildStorno(original, { invoiceNumber: 'STORNO-1' });
    const invoice = storno.invoiceMain.invoice!;

    expect(storno.invoiceNumber).toBe('STORNO-1');
    expect(invoice.invoiceReference?.originalInvoiceNumber).toBe(input.invoiceNumber);
    expect(invoice.invoiceReference?.modificationIndex).toBe(1);

    const lineCount = invoice.invoiceLines!.line.length;
    const first = invoice.invoiceLines!.line[0]!;
    // lineOperation CREATE, chain reference continues past the original.
    expect(first.lineModificationReference?.lineOperation).toBe('CREATE');
    expect(first.lineModificationReference?.lineNumberReference).toBe(lineCount + 1);
    expect(first.lineAmountsNormal!.lineNetAmountData.lineNetAmount).toBe('-10000.00');

    // Amounts and summary are negated, and it reconciles + validates as STORNO.
    expect(invoice.invoiceSummary.summaryNormal?.invoiceNetAmount).toBe('-20000.00');
    expect(checkInvoiceSummary(invoice)).toEqual([]);
    expect(validateInvoice(storno, { operation: 'STORNO' }).errors).toEqual([]);
  });

  it('requires the supplier tax number', () => {
    expect(() =>
      buildInvoice({ ...input, supplier: { ...input.supplier, taxNumber: undefined } }),
    ).toThrowError(/supplier tax number/);
  });

  it('carries a foreign currency with its HUF twins at the exchange rate', () => {
    const invoice = buildInvoice({
      ...input,
      currency: 'EUR',
      exchangeRate: 400,
      lines: [{ description: 'Export', quantity: 1, unitPrice: 100, vatPercentage: 0 }],
    }).invoiceMain.invoice!;
    const amounts = invoice.invoiceLines!.line[0]!.lineAmountsNormal!;
    expect(amounts.lineNetAmountData.lineNetAmount).toBe('100.00');
    expect(amounts.lineNetAmountData.lineNetAmountHUF).toBe('40000.00');
  });
});
