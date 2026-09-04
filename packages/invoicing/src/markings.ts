import type { InvoiceType, LineType, VatRateType } from '@open-nav/core';
import { marginSchemeLabel, label } from './labels.js';
import type { DocumentLanguage } from './format.js';

/**
 * A phrase the VAT Act requires on the invoice itself.
 *
 * Section 169 of the VAT Act (Áfa tv. 169. §) prescribes not just the figures
 * but specific wording: an exempt supply must state the legal ground, a
 * domestic reverse charge must say "fordított adózás", cash accounting must
 * say "pénzforgalmi elszámolás", and so on. These are derived from the data
 * rather than left to whoever fills in a template, because a missing phrase
 * makes the invoice defective even when every number on it is right.
 */
export interface Marking {
  /** The text to print, in the document's language. */
  text: string;
  /** Where the requirement comes from, for the reader and for review. */
  reference: string;
  /** Free text NAV carries alongside a coded reason, if any. */
  detail?: string;
}

function vatRatesOf(invoice: InvoiceType): VatRateType[] {
  const lines: LineType[] = invoice.invoiceLines?.line ?? [];
  const fromLines = lines.flatMap((line) =>
    [line.lineAmountsNormal?.lineVatRate, line.lineAmountsSimplified?.lineVatRate].filter(
      (rate): rate is VatRateType => rate !== undefined,
    ),
  );
  const fromSummary = [
    ...(invoice.invoiceSummary.summaryNormal?.summaryByVatRate ?? []).map((entry) => entry.vatRate),
    ...(invoice.invoiceSummary.summarySimplified ?? []).map((entry) => entry.vatRate),
  ];
  return [...fromLines, ...fromSummary];
}

/**
 * Derive every marking the invoice must carry.
 *
 * Duplicates are collapsed: a reverse charge on twelve lines is one phrase on
 * the document, not twelve.
 */
export function deriveMarkings(invoice: InvoiceType, language: DocumentLanguage): Marking[] {
  const markings = new Map<string, Marking>();
  const add = (marking: Marking): void => {
    markings.set(`${marking.text}|${marking.detail ?? ''}`, marking);
  };

  const detail = invoice.invoiceHead.invoiceDetail;

  if (detail.cashAccountingIndicator) {
    add({ text: label('cashAccounting', language), reference: 'Áfa tv. 169. § h)' });
  }
  if (detail.selfBillingIndicator) {
    add({ text: label('selfBilling', language), reference: 'Áfa tv. 169. § l)' });
  }
  if (invoice.invoiceHead.fiscalRepresentativeInfo) {
    add({
      text: `${label('fiscalRepresentative', language)}: ${invoice.invoiceHead.fiscalRepresentativeInfo.fiscalRepresentativeName}`,
      reference: 'Áfa tv. 169. § p)',
    });
  }

  for (const rate of vatRatesOf(invoice)) {
    if (rate.vatDomesticReverseCharge) {
      add({ text: label('reverseCharge', language), reference: 'Áfa tv. 169. § n)' });
    }
    if (rate.vatExemption) {
      add({
        text: `${label('exempt', language)} — ${rate.vatExemption.case}`,
        reference: 'Áfa tv. 169. § m)',
        detail: rate.vatExemption.reason,
      });
    }
    if (rate.vatOutOfScope) {
      add({
        text: `${label('outOfScope', language)} — ${rate.vatOutOfScope.case}`,
        reference: 'Áfa tv. 169. § m)',
        detail: rate.vatOutOfScope.reason,
      });
    }
    if (rate.marginSchemeIndicator) {
      add({
        text: marginSchemeLabel(rate.marginSchemeIndicator, language),
        reference: 'Áfa tv. 169. § o) p)',
      });
    }
    if (rate.noVatCharge) {
      add({ text: label('outOfScope', language), reference: 'Áfa tv. 169. § m)' });
    }
  }

  const hasNewTransportMean = (invoice.invoiceLines?.line ?? []).some(
    (line) => line.newTransportMean !== undefined,
  );
  if (hasNewTransportMean) {
    add({ text: label('newTransportMean', language), reference: 'Áfa tv. 169. § k)' });
  }

  return [...markings.values()];
}
