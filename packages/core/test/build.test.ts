import { describe, expect, it } from 'vitest';
import {
  buildAdvanceInvoice,
  buildInvoice,
  buildModify,
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

  it('accepts gross-entered unit prices and derives the net line', () => {
    const invoice = buildInvoice({
      ...input,
      priceMode: 'gross',
      lines: [{ description: 'Bruttó árból', quantity: 1, unitPrice: 1270, vatPercentage: 0.27 }],
    }).invoiceMain.invoice!;
    const amounts = invoice.invoiceLines!.line[0]!.lineAmountsNormal!;
    // 1270 gross at 27% => 1000 net, 270 VAT, and it still validates + reconciles.
    expect(amounts.lineNetAmountData.lineNetAmount).toBe('1000.00');
    expect(amounts.lineVatData!.lineVatAmount).toBe('270.00');
    expect(amounts.lineGrossAmountData!.lineGrossAmountNormal).toBe('1270.00');
    expect(
      validateInvoice(buildInvoice({ ...input, priceMode: 'gross' }), { operation: 'CREATE' })
        .errors,
    ).toEqual([]);
  });

  it('marks a periodic-settlement delivery period', () => {
    const detail = buildInvoice({
      ...input,
      deliveryPeriod: { start: '2026-03-01', end: '2026-03-31' },
    }).invoiceMain.invoice!.invoiceHead.invoiceDetail;
    expect(detail.invoiceDeliveryPeriodStart).toBe('2026-03-01');
    expect(detail.invoiceDeliveryPeriodEnd).toBe('2026-03-31');
    expect(detail.periodicalSettlement).toBe(true);
  });

  it('carries order numbers and conventional invoice info', () => {
    const detail = buildInvoice({ ...input, orderNumbers: ['PO-1', 'PO-2'] }).invoiceMain.invoice!
      .invoiceHead.invoiceDetail;
    expect(detail.conventionalInvoiceInfo?.orderNumbers?.orderNumber).toEqual(['PO-1', 'PO-2']);
  });

  it('carries structured additional data on the invoice and lines, and validates', () => {
    const built = buildInvoice({
      ...input,
      additionalData: [
        { dataName: 'K12345_NOTE', dataDescription: 'Megjegyzés', dataValue: 'invoice note' },
      ],
      lines: [
        {
          description: 'Widget',
          quantity: 1,
          unitPrice: 1000,
          vatPercentage: 0.27,
          additionalData: [
            {
              dataName: 'K12345_LINE',
              dataDescription: 'Tétel megjegyzés',
              dataValue: 'line note',
            },
          ],
        },
      ],
    });
    const invoice = built.invoiceMain.invoice!;
    expect(invoice.invoiceHead.invoiceDetail.additionalInvoiceData?.[0]?.dataValue).toBe(
      'invoice note',
    );
    expect(invoice.invoiceLines!.line[0]!.additionalLineData?.[0]?.dataValue).toBe('line note');
    expect(validateInvoice(built, { operation: 'CREATE' }).errors).toEqual([]);
    // Survives the XML round trip (serializer orders the new fields correctly).
    expect(parseDocument(serializeDocument('InvoiceData', built)).value).toEqual(built);
  });

  it('builds an advance invoice with advance-marked lines and a derived VAT summary', () => {
    const built = buildAdvanceInvoice({
      ...input,
      lines: [
        { description: 'konyhabútor előleg', quantity: 1, unitPrice: 500000, vatPercentage: 0.27 },
      ],
    });
    const line = built.invoiceMain.invoice!.invoiceLines!.line[0]!;
    // Advance line: advanceIndicator set, and only net + VAT rate on the line.
    expect(line.advanceData?.advanceIndicator).toBe(true);
    expect(line.lineAmountsNormal!.lineNetAmountData.lineNetAmount).toBe('500000.00');
    expect(line.lineAmountsNormal!.lineVatData).toBeUndefined();
    expect(line.lineAmountsNormal!.lineGrossAmountData).toBeUndefined();
    // The summary still derives the VAT from the rate, and it validates.
    const summary = built.invoiceMain.invoice!.invoiceSummary;
    expect(summary.summaryNormal?.invoiceVatAmount).toBe('135000.00');
    expect(summary.summaryGrossData?.invoiceGrossAmount).toBe('635000.00');
    expect(validateInvoice(built, { operation: 'CREATE' }).errors).toEqual([]);
    // Survives the XML round trip (serializer places advanceData correctly).
    expect(parseDocument(serializeDocument('InvoiceData', built)).value).toEqual(built);
  });

  it('builds a final invoice (végszámla) that deducts a referenced advance', () => {
    const built = buildInvoice({
      ...input,
      lines: [
        { description: 'Teljes ellenérték', quantity: 1, unitPrice: 1000000, vatPercentage: 0.27 },
        {
          description: 'Előleg beszámítás',
          quantity: 1,
          unitPrice: -500000,
          vatPercentage: 0.27,
          advance: { originalInvoice: 'AAA000567', paymentDate: '2026-05-02' },
        },
      ],
    });
    const deduction = built.invoiceMain.invoice!.invoiceLines!.line[1]!;
    // Deduction line references the advance invoice and keeps full (negative) amounts.
    expect(deduction.advanceData?.advancePaymentData?.advanceOriginalInvoice).toBe('AAA000567');
    expect(deduction.advanceData?.advancePaymentData?.advanceExchangeRate).toBe('1');
    expect(deduction.lineAmountsNormal!.lineNetAmountData.lineNetAmount).toBe('-500000.00');
    expect(deduction.lineAmountsNormal!.lineVatData!.lineVatAmount).toBe('-135000.00');
    // Net settles to 500000, and it validates as a normal CREATE.
    expect(built.invoiceMain.invoice!.invoiceSummary.summaryNormal?.invoiceNetAmount).toBe(
      '500000.00',
    );
    expect(validateInvoice(built, { operation: 'CREATE' }).errors).toEqual([]);
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

describe('buildModify', () => {
  const corrective: BuildInvoiceInput = {
    ...input,
    invoiceNumber: 'MODIFY-1',
    lines: [{ description: 'Pótlólagos tétel', quantity: 1, unitPrice: 500, vatPercentage: 0.27 }],
  };

  it('references the original and continues line numbering past the chain', () => {
    // First modify on a 2-line invoice: chain base 2 → new line takes position 3.
    const doc = buildModify(corrective, {
      originalInvoiceNumber: input.invoiceNumber,
      chainLineBase: 2,
      modificationIndex: 1,
    });
    const invoice = doc.invoiceMain.invoice!;

    expect(doc.invoiceNumber).toBe('MODIFY-1');
    expect(invoice.invoiceReference?.originalInvoiceNumber).toBe(input.invoiceNumber);
    expect(invoice.invoiceReference?.modifyWithoutMaster).toBe(false);
    expect(invoice.invoiceReference?.modificationIndex).toBe(1);

    const line = invoice.invoiceLines!.line[0]!;
    expect(line.lineNumber).toBe(1); // document line numbers stay 1..N
    expect(line.lineModificationReference?.lineOperation).toBe('CREATE');
    expect(line.lineModificationReference?.lineNumberReference).toBe(3);
    expect(validateInvoice(doc, { operation: 'MODIFY' }).errors).toEqual([]);
  });

  it('sequences a second modification after the first', () => {
    // Original 2 lines + first modify 1 line = base 3 → second modify takes position 4.
    const doc = buildModify(corrective, {
      originalInvoiceNumber: input.invoiceNumber,
      chainLineBase: 3,
      modificationIndex: 2,
    });
    const invoice = doc.invoiceMain.invoice!;
    expect(invoice.invoiceReference?.modificationIndex).toBe(2);
    expect(invoice.invoiceLines!.line[0]!.lineModificationReference?.lineNumberReference).toBe(4);
  });

  it('defaults chainLineBase to 0 and modificationIndex to 1', () => {
    const doc = buildModify(corrective, { originalInvoiceNumber: input.invoiceNumber });
    const invoice = doc.invoiceMain.invoice!;
    expect(invoice.invoiceReference?.modificationIndex).toBe(1);
    expect(invoice.invoiceLines!.line[0]!.lineModificationReference?.lineNumberReference).toBe(1);
  });
});

describe('buildStorno (chained, storno-after-modify)', () => {
  it('reverses the current chain state with references past the whole chain', () => {
    // Current state = original 2 lines + one módosító line = 3 lines. Storno reverses
    // all 3; references continue at chain positions 4,5,6 (base 3), index 2 in the chain.
    const current = buildInvoice({
      ...input,
      lines: [
        ...input.lines,
        { description: 'Pótlólag', quantity: 1, unitPrice: 500, vatPercentage: 0.27 },
      ],
    });
    const storno = buildStorno(current, { invoiceNumber: 'STORNO-CHAIN-1', modificationIndex: 2 });
    const invoice = storno.invoiceMain.invoice!;

    expect(invoice.invoiceReference?.modificationIndex).toBe(2);
    const refs = invoice.invoiceLines!.line.map(
      (l) => l.lineModificationReference?.lineNumberReference,
    );
    expect(refs).toEqual([4, 5, 6]); // base = current line count (3) + index + 1
    expect(checkInvoiceSummary(invoice)).toEqual([]);
    expect(validateInvoice(storno, { operation: 'STORNO' }).errors).toEqual([]);
  });

  it('honours an explicit chainLineBase override', () => {
    const original = buildInvoice(input); // 2 lines
    const storno = buildStorno(original, { invoiceNumber: 'STORNO-BASE', chainLineBase: 5 });
    const first = storno.invoiceMain.invoice!.invoiceLines!.line[0]!;
    expect(first.lineModificationReference?.lineNumberReference).toBe(6); // 5 + 0 + 1
  });
});
