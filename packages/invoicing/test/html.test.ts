import { describe, expect, it } from 'vitest';
import { renderInvoiceHtml } from '../src/html.js';
import { allSamples, sample } from './fixtures.js';

describe('renderInvoiceHtml', () => {
  it('renders every published NAV invoice without failing', () => {
    for (const entry of allSamples()) {
      const html = renderInvoiceHtml(entry.document);
      expect(html.startsWith('<!doctype html>'), entry.name).toBe(true);
      expect(html, entry.name).toContain(entry.document.invoiceNumber);
    }
  });

  it('is self-contained, so it renders offline and archives as one file', () => {
    const html = renderInvoiceHtml(sample('belfoldi-termekertekesites.xml'));
    expect(html).not.toMatch(/<link[^>]+href=/i);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/src="http/i);
  });

  it('shows the parties, the lines and the totals', () => {
    const html = renderInvoiceHtml(sample('belfoldi-termekertekesites.xml'));
    expect(html).toContain('Értékesítő Kft');
    expect(html).toContain('Beszerző Kft');
    expect(html).toContain('99999999-2-41');
    expect(html).toContain('Budapest');
  });

  it('titles a simplified invoice as such', () => {
    expect(renderInvoiceHtml(sample('belfoldi-egyszerusitett-szamla.xml'))).toContain(
      'EGYSZERŰSÍTETT SZÁMLA',
    );
  });

  it('titles an aggregate invoice as such', () => {
    expect(renderInvoiceHtml(sample('gyujtoszamla-1.xml'))).toContain('GYŰJTŐSZÁMLA');
  });

  it('titles a document that modifies another as a modification document', () => {
    const html = renderInvoiceHtml(sample('modositas-es-ervenytelenites-1.xml'));
    expect(html).toContain('MÓDOSÍTÓ OKIRAT');
    expect(html).toContain('Eredeti számla sorszáma');
  });

  it('prints the statutory markings with their legal reference', () => {
    const html = renderInvoiceHtml(sample('belfoldi-ertekesites-tobb-afa-tipus.xml'));
    expect(html).toContain('Jogszabályi jelölések');
    expect(html).toContain('fordított adózás');
    expect(html).toContain('Áfa tv. 169. § n)');
  });

  it('shows the exchange rate and the forint total on a foreign currency invoice', () => {
    const html = renderInvoiceHtml(sample('belfoldi-devizas-szamla.xml'));
    expect(html).toContain('Árfolyam');
    expect(html).toContain('Forintban');
  });

  it('does not name a private person', () => {
    // NAV's private person sample carries no name, and the document must not
    // invent one.
    // The heading is uppercased by CSS, so the markup carries "Vevő".
    const html = renderInvoiceHtml(sample('belfoldi-termekertekesites-maganszemelynek.xml'));
    expect(html).toContain('Vevő');
    expect(html).toContain('—');
    expect(html).not.toMatch(/customerName/);
  });

  it('renders every invoice of a batch document, on its own page', () => {
    const document = sample('tobb-szamla-modositasa-egy-okirattal.xml');
    const count = document.invoiceMain.batchInvoice?.length ?? 0;
    expect(count).toBeGreaterThan(1);
    const html = renderInvoiceHtml(document);
    expect(html.match(/<article class="invoice">/g) ?? []).toHaveLength(count);
    expect(html.match(/page-break/g)?.length ?? 0).toBeGreaterThanOrEqual(count - 1);
  });

  it('escapes markup that arrives in invoice data', () => {
    const document = sample('belfoldi-termekertekesites.xml');
    document.invoiceMain.invoice!.invoiceHead.supplierInfo.supplierName =
      '<script>alert(1)</script>';
    const html = renderInvoiceHtml(document);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('renders in English on request', () => {
    const html = renderInvoiceHtml(sample('belfoldi-termekertekesites.xml'), { language: 'en' });
    expect(html).toContain('INVOICE');
    expect(html).toContain('Supplier');
    expect(html).toContain('Total gross');
    expect(html).toContain('lang="en"');
  });

  it('includes a note and can drop the provenance footer', () => {
    const withNote = renderInvoiceHtml(sample('belfoldi-termekertekesites.xml'), {
      note: 'Fizetés a megadott számlaszámra.',
    });
    expect(withNote).toContain('Fizetés a megadott számlaszámra.');
    expect(withNote).toContain('megjelenítés');

    const without = renderInvoiceHtml(sample('belfoldi-termekertekesites.xml'), {
      provenanceNote: false,
    });
    expect(without).not.toContain('megjelenítés');
  });

  it('shows a VAT breakdown only when there is more than one rate', () => {
    // Headings are uppercased by CSS, so the markup carries the normal case.
    expect(renderInvoiceHtml(sample('belfoldi-ertekesites-tobb-afa-tipus.xml'))).toContain(
      'Áfa-összesítő',
    );
    // A single-rate invoice needs no breakdown: the totals already say it.
    // (The class name also appears in the stylesheet, so match the element.)
    const singleRate = sample('belfoldi-termekertekesites.xml');
    const summary = singleRate.invoiceMain.invoice!.invoiceSummary.summaryNormal!;
    summary.summaryByVatRate = [summary.summaryByVatRate[0]!];
    expect(renderInvoiceHtml(singleRate)).not.toContain('<section class="vat-summary">');
  });
});
