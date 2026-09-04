import { describe, expect, it } from 'vitest';
import type { InvoiceType } from '@open-nav/core';
import { deriveMarkings } from '../src/markings.js';
import { sample } from './fixtures.js';

/**
 * Section 169 of the VAT Act requires particular phrases on the invoice.
 * These are derived from the data rather than left to a template, so each
 * case is pinned down here.
 */

function invoiceOf(name: string): InvoiceType {
  const document = sample(name);
  return document.invoiceMain.invoice ?? document.invoiceMain.batchInvoice![0]!.invoice;
}

const texts = (invoice: InvoiceType): string[] =>
  deriveMarkings(invoice, 'hu').map((marking) => marking.text);

describe('deriveMarkings', () => {
  it('finds nothing to state on a plain domestic sale', () => {
    expect(texts(invoiceOf('belfoldi-termekertekesites.xml'))).toEqual([]);
  });

  it('states domestic reverse charge', () => {
    const invoice = invoiceOf('belfoldi-termekertekesites.xml');
    invoice.invoiceLines!.line[0]!.lineAmountsNormal!.lineVatRate = {
      vatDomesticReverseCharge: true,
    };
    expect(texts(invoice)).toContain('fordított adózás');
  });

  it('states the legal ground of an exemption', () => {
    const invoice = invoiceOf('belfoldi-termekertekesites.xml');
    invoice.invoiceLines!.line[0]!.lineAmountsNormal!.lineVatRate = {
      vatExemption: { case: 'AAM', reason: 'alanyi adómentesség' },
    };
    const markings = deriveMarkings(invoice, 'hu');
    const exemption = markings.find((marking) => marking.text.includes('AAM'));
    expect(exemption?.detail).toBe('alanyi adómentesség');
    expect(exemption?.reference).toBe('Áfa tv. 169. § m)');
  });

  it('states the margin scheme in the wording the law uses', () => {
    const invoice = invoiceOf('belfoldi-termekertekesites.xml');
    invoice.invoiceLines!.line[0]!.lineAmountsNormal!.lineVatRate = {
      marginSchemeIndicator: 'TRAVEL_AGENCY',
    };
    expect(texts(invoice)).toContain('különbözet szerinti szabályozás – utazási irodák');
  });

  it('states cash accounting and self-billing', () => {
    const invoice = invoiceOf('belfoldi-termekertekesites.xml');
    invoice.invoiceHead.invoiceDetail.cashAccountingIndicator = true;
    invoice.invoiceHead.invoiceDetail.selfBillingIndicator = true;
    const found = texts(invoice);
    expect(found).toContain('pénzforgalmi elszámolás');
    expect(found).toContain('önszámlázás');
  });

  it('says each phrase once however many lines carry it', () => {
    const invoice = invoiceOf('belfoldi-termekertekesites.xml');
    for (const line of invoice.invoiceLines!.line) {
      line.lineAmountsNormal!.lineVatRate = { vatDomesticReverseCharge: true };
    }
    expect(invoice.invoiceLines!.line.length).toBeGreaterThan(1);
    expect(texts(invoice).filter((text) => text === 'fordított adózás')).toHaveLength(1);
  });

  it('keeps exemptions with different legal grounds apart', () => {
    const invoice = invoiceOf('belfoldi-termekertekesites.xml');
    const lines = invoice.invoiceLines!.line;
    lines[0]!.lineAmountsNormal!.lineVatRate = { vatExemption: { case: 'AAM', reason: 'a' } };
    lines[1]!.lineAmountsNormal!.lineVatRate = { vatExemption: { case: 'TAM', reason: 'b' } };
    const found = texts(invoice);
    expect(found.some((text) => text.includes('AAM'))).toBe(true);
    expect(found.some((text) => text.includes('TAM'))).toBe(true);
  });

  it('reads the markings of a real multi-rate invoice', () => {
    const found = texts(invoiceOf('belfoldi-ertekesites-tobb-afa-tipus.xml'));
    expect(found).toContain('fordított adózás');
    expect(found.some((text) => text.startsWith('különbözet szerinti'))).toBe(true);
    expect(found.some((text) => text.includes('TAM'))).toBe(true);
  });

  it('states a supply of a new means of transport', () => {
    expect(texts(invoiceOf('uj-kozlekedesi-eszkoz-export.xml'))).toContain(
      'új közlekedési eszköz értékesítése',
    );
  });

  it('translates the phrases when the document is in English', () => {
    const invoice = invoiceOf('belfoldi-termekertekesites.xml');
    invoice.invoiceHead.invoiceDetail.cashAccountingIndicator = true;
    expect(deriveMarkings(invoice, 'en').map((marking) => marking.text)).toContain(
      'cash accounting',
    );
  });
});
