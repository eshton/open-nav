import { describe, expect, it } from 'vitest';
import { buildInvoice, type BuildInvoiceInput } from '@open-nav/core';
import { buildVatAnalytics, buildVatAnalyticsItem } from '../src/bridge.js';

const base: BuildInvoiceInput = {
  invoiceNumber: 'OUT-2026-001',
  issueDate: '2026-04-10',
  deliveryDate: '2026-04-10',
  paymentMethod: 'TRANSFER',
  supplier: {
    name: 'Seller Kft',
    taxNumber: '11111111',
    address: {
      postalCode: '1011',
      city: 'Budapest',
      streetName: 'Fő',
      publicPlaceCategory: 'utca',
      number: '1',
    },
  },
  customer: {
    name: 'Buyer Kft',
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
    { description: 'A', quantity: 10, unitPrice: 1000, vatPercentage: 0.27 },
    { description: 'B', quantity: 2, unitPrice: 5000, vatPercentage: 0.27 },
  ],
};

describe('buildVatAnalyticsItem', () => {
  it('aggregates an outbound invoice into a PAYABLE position by rate', () => {
    const item = buildVatAnalyticsItem(buildInvoice(base), {
      direction: 'OUTBOUND',
      lineNumber: 1,
      taxCode: ({ vatPercentage }) => (vatPercentage === '0.27' ? 'MP07' : 'MP00'),
    });

    expect(item.sourceDocumentId).toBe('OUT-2026-001');
    expect(item.sourceDocumentType).toBe('INVOICE');
    expect(item.taxpointDate).toBe('2026-04-10');
    expect(item.invoiceModificationOrCancellation).toBe(false);
    expect(item.partnerInfo.partnerStatus).toBe('DOMESTIC');
    expect(item.partnerInfo.partnerTaxData?.domesticTaxData?.taxNumber).toBe('22222222');

    // One 27% group: net 20000, VAT 5400.
    expect(item.taxInformation).toHaveLength(1);
    const info = item.taxInformation[0]!;
    expect(info.standardTaxCode).toBe('MP07');
    expect(info.taxPosition[0]!.positionType).toBe('PAYABLE');
    expect(info.taxPosition[0]!.taxBase).toBe('20000.00');
    expect(info.taxPosition[0]!.taxAmount).toBe('5400.00');
  });

  it('splits distinct VAT rates into separate tax-information blocks', () => {
    const item = buildVatAnalyticsItem(
      buildInvoice({
        ...base,
        lines: [
          { description: 'std', quantity: 1, unitPrice: 1000, vatPercentage: 0.27 },
          { description: 'reduced', quantity: 1, unitPrice: 1000, vatPercentage: 0.05 },
        ],
      }),
      {
        direction: 'OUTBOUND',
        lineNumber: 1,
        taxCode: ({ vatPercentage }) => `CODE_${vatPercentage}`,
      },
    );
    expect(item.taxInformation.map((i) => i.standardTaxCode).sort()).toEqual([
      'CODE_0.05',
      'CODE_0.27',
    ]);
  });

  it('maps an inbound invoice to a DEDUCTIBLE position with the supplier as partner', () => {
    const item = buildVatAnalyticsItem(buildInvoice(base), {
      direction: 'INBOUND',
      lineNumber: 1,
      taxCode: () => 'MD07',
    });
    expect(item.partnerInfo.partnerTaxData?.domesticTaxData?.taxNumber).toBe('11111111');
    expect(item.taxInformation[0]!.taxPosition[0]!.positionType).toBe('DEDUCTIBLE');
  });

  it('wraps items with a total row count', () => {
    const item = buildVatAnalyticsItem(buildInvoice(base), {
      direction: 'OUTBOUND',
      lineNumber: 1,
      taxCode: () => 'MP07',
    });
    const analytics = buildVatAnalytics([item]);
    expect(analytics.totalRowCount).toBe(1);
    expect(analytics.vatAnalyticsItem).toHaveLength(1);
  });
});
