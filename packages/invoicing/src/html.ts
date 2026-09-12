import type { AddressType, InvoiceData, InvoiceType, LineType, VatRateType } from '@open-nav/core';
import {
  escapeHtml,
  formatAmount,
  formatDate,
  formatPercentage,
  formatTaxNumber,
  type DocumentLanguage,
} from './format.js';
import { label, paymentMethodLabel, unitLabel } from './labels.js';
import {
  documentDisplay,
  documentHeading,
  lineColumns,
  type DocumentType,
  type LineColumn,
} from './documents.js';
import { deriveMarkings } from './markings.js';
import { buildStyles, resolveTheme, type InvoiceTheme, type ResolvedTheme } from './theme.js';

export interface RenderOptions {
  /** Document language. Hungarian by default, as the law prescribes. */
  language?: DocumentLanguage;
  /**
   * The kind of document to render. Defaults to `invoice` (the tax invoice).
   * `proforma`, `deliveryNote` and `receipt` are printable business documents
   * rendered from the same data but reported nowhere through Online Számla;
   * they drop the money detail they should not show and carry a "not a tax
   * invoice" note instead of the NAV-provenance note. See {@link DocumentType}.
   */
  documentType?: DocumentType;
  /** Extra note printed under the totals, e.g. payment instructions. */
  note?: string;
  /**
   * Branding and layout: logo, colours, fonts, page setup, footer.
   *
   * See {@link InvoiceTheme}. Anything omitted falls back to a restrained
   * default that prints well in black and white.
   */
  theme?: InvoiceTheme;
  /**
   * State that the document was rendered from reported data.
   *
   * On by default. An invoice's legal original is whatever the issuer issued;
   * this rendering is a faithful presentation of the reported data, and
   * saying so avoids passing it off as something it is not. Can also be set
   * through the theme.
   */
  provenanceNote?: boolean;
}

/**
 * Render an invoice as a self-contained, printable HTML document.
 *
 * HTML rather than PDF on purpose. A Hungarian invoice needs `ő` and `ű`,
 * which are outside the WinAnsi encoding the PDF core fonts use, so a
 * dependency-free PDF would need a bundled and licensed font to spell the
 * language correctly. HTML gets the typography right, needs nothing bundled,
 * and turns into a PDF with any browser:
 *
 * ```sh
 * chromium --headless --print-to-pdf=invoice.pdf invoice.html
 * ```
 *
 * The output carries no external references, so it renders identically
 * offline and archives as a single file.
 */
export function renderInvoiceHtml(document: InvoiceData, options: RenderOptions = {}): string {
  const language = options.language ?? 'hu';
  const theme = resolveTheme(options.theme);
  const invoices = document.invoiceMain.invoice
    ? [document.invoiceMain.invoice]
    : (document.invoiceMain.batchInvoice ?? []).map((entry) => entry.invoice);

  const body = invoices
    .map((invoice) => renderInvoice(document, invoice, language, options, theme))
    .join('\n<div class="page-break"></div>\n');

  return `<!doctype html>
<html lang="${language}">
<head>
<meta charset="utf-8">
<title>${escapeHtml(document.invoiceNumber)}</title>
${buildStyles(theme)}
</head>
<body>
${body}
</body>
</html>
`;
}

/** Render a proforma invoice (díjbekérő) — a payment request, not a tax invoice. */
export function renderProformaHtml(
  document: InvoiceData,
  options: Omit<RenderOptions, 'documentType'> = {},
): string {
  return renderInvoiceHtml(document, { ...options, documentType: 'proforma' });
}

/** Render a delivery note (szállítólevél) — goods delivered, no prices. */
export function renderDeliveryNoteHtml(
  document: InvoiceData,
  options: Omit<RenderOptions, 'documentType'> = {},
): string {
  return renderInvoiceHtml(document, { ...options, documentType: 'deliveryNote' });
}

/** Render a receipt (nyugta) — simplified proof of payment showing the gross total. */
export function renderReceiptHtml(
  document: InvoiceData,
  options: Omit<RenderOptions, 'documentType'> = {},
): string {
  return renderInvoiceHtml(document, { ...options, documentType: 'receipt' });
}

function renderInvoice(
  document: InvoiceData,
  invoice: InvoiceType,
  language: DocumentLanguage,
  options: RenderOptions,
  theme: ResolvedTheme,
): string {
  const detail = invoice.invoiceHead.invoiceDetail;
  const currency = detail.currencyCode;
  const isModification = invoice.invoiceReference !== undefined;
  const lines = invoice.invoiceLines?.line ?? [];
  const documentType = options.documentType ?? 'invoice';
  const display = documentDisplay(documentType);
  const markings = display.markings ? deriveMarkings(invoice, language) : [];
  const columns = lineColumns(display.lineMoney);

  const metaRows: Array<[string, string]> = [
    [label('invoiceNumber', language), document.invoiceNumber],
    [label('issueDate', language), formatDate(document.invoiceIssueDate, language)],
  ];
  if (detail.invoiceDeliveryDate) {
    metaRows.push([
      label('deliveryDate', language),
      formatDate(detail.invoiceDeliveryDate, language),
    ]);
  }
  if (detail.invoiceDeliveryPeriodStart && detail.invoiceDeliveryPeriodEnd) {
    metaRows.push([
      label('deliveryPeriod', language),
      `${formatDate(detail.invoiceDeliveryPeriodStart, language)} – ${formatDate(detail.invoiceDeliveryPeriodEnd, language)}`,
    ]);
  }
  if (detail.paymentDate) {
    metaRows.push([label('paymentDate', language), formatDate(detail.paymentDate, language)]);
  }
  if (detail.paymentMethod) {
    metaRows.push([
      label('paymentMethod', language),
      paymentMethodLabel(detail.paymentMethod, language),
    ]);
  }
  metaRows.push([label('currency', language), currency]);
  if (detail.exchangeRate && currency !== 'HUF') {
    metaRows.push([label('exchangeRate', language), `${detail.exchangeRate} HUF/${currency}`]);
  }
  if (invoice.invoiceReference) {
    metaRows.push([
      label('originalInvoiceNumber', language),
      invoice.invoiceReference.originalInvoiceNumber,
    ]);
  }

  const logo = theme.logo
    ? `<img class="logo" src="${escapeHtml(theme.logo.src)}" alt="${escapeHtml(theme.logo.alt ?? invoice.invoiceHead.supplierInfo.supplierName)}"` +
      `${theme.logo.width ? ` style="width:${escapeHtml(theme.logo.width)}"` : ''}>`
    : '';

  return `<article class="invoice">
  <header>
    <div class="brand">
      ${logo}
      <div>
        <h1>${escapeHtml(documentHeading(documentType, detail.invoiceCategory, isModification, language))}</h1>
        ${markings.length > 0 ? `<div class="subtitle">${markings.map((marking) => escapeHtml(marking.text)).join(' · ')}</div>` : ''}
        ${display.disclaimerKey ? `<div class="disclaimer">${escapeHtml(label(display.disclaimerKey, language))}</div>` : ''}
      </div>
    </div>
    <div class="meta">
      ${metaRows
        .map(
          ([name, value]) =>
            `<div>${escapeHtml(name)}: <span class="value">${escapeHtml(value)}</span></div>`,
        )
        .join('\n      ')}
    </div>
  </header>

  <section class="parties">
    ${renderParty(label('supplier', language), supplierFields(invoice, language), theme.issuerContact)}
    ${renderParty(label('customer', language), customerFields(invoice, language), [])}
  </section>

  ${renderLines(lines, currency, language, columns)}
  ${renderTotals(invoice, currency, language, display.totals)}
  ${display.vatSummary ? renderVatSummary(invoice, currency, language) : ''}
  ${renderMarkings(markings, language)}
  ${options.note ? `<div class="note">${escapeHtml(options.note)}</div>` : ''}
  ${renderFooter(theme, options, language, display.provenance)}
</article>`;
}

function renderParty(
  heading: string,
  fields: { name: string; address: string; rows: Array<[string, string]> },
  contact: string[],
): string {
  return `<div class="party">
      <h2>${escapeHtml(heading)}</h2>
      <div class="name">${escapeHtml(fields.name)}</div>
      ${fields.address ? `<div class="address">${escapeHtml(fields.address)}</div>` : ''}
      <dl>
        ${fields.rows
          .map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd>`)
          .join('\n        ')}
      </dl>
      ${
        contact.length > 0
          ? `<div class="contact">${contact.map((line) => escapeHtml(line)).join('<br>')}</div>`
          : ''
      }
    </div>`;
}

/**
 * The footer carries the theme's own lines plus the provenance note.
 *
 * `provenanceNote` can be set on either the options or the theme; the option
 * wins, so a single document can drop it without editing shared branding.
 */
function renderFooter(
  theme: ResolvedTheme,
  options: RenderOptions,
  language: DocumentLanguage,
  provenanceAllowed: boolean,
): string {
  // A non-tax document was never reported, so the provenance note never applies
  // to it, whatever the option or theme says.
  const showProvenance = provenanceAllowed && (options.provenanceNote ?? theme.provenanceNote);
  const lines = [
    ...theme.footerLines.map((line) => escapeHtml(line)),
    ...(showProvenance ? [escapeHtml(label('notReported', language))] : []),
  ];
  if (lines.length === 0) return '';
  return `<footer>${lines.map((line) => `<div>${line}</div>`).join('')}</footer>`;
}

function formatAddress(address: AddressType | undefined): string {
  if (!address) return '';
  if ('simpleAddress' in address && address.simpleAddress) {
    const simple = address.simpleAddress;
    return [simple.postalCode, simple.city, simple.additionalAddressDetail, simple.countryCode]
      .filter(Boolean)
      .join(', ');
  }
  if ('detailedAddress' in address && address.detailedAddress) {
    const detailed = address.detailedAddress;
    const street = [
      detailed.streetName,
      detailed.publicPlaceCategory,
      detailed.number,
      detailed.building,
      detailed.floor,
      detailed.door,
    ]
      .filter(Boolean)
      .join(' ');
    return [detailed.postalCode, detailed.city, street, detailed.countryCode]
      .filter(Boolean)
      .join(', ');
  }
  return '';
}

function supplierFields(
  invoice: InvoiceType,
  language: DocumentLanguage,
): { name: string; address: string; rows: Array<[string, string]> } {
  const supplier = invoice.invoiceHead.supplierInfo;
  const rows: Array<[string, string]> = [];
  rows.push([label('taxNumber', language), formatTaxNumber(supplier.supplierTaxNumber)]);
  if (supplier.groupMemberTaxNumber) {
    rows.push([
      label('groupMemberTaxNumber', language),
      formatTaxNumber(supplier.groupMemberTaxNumber),
    ]);
  }
  if (supplier.communityVatNumber) {
    rows.push([label('communityVatNumber', language), supplier.communityVatNumber]);
  }
  if (supplier.supplierBankAccountNumber) {
    rows.push([label('bankAccount', language), supplier.supplierBankAccountNumber]);
  }
  return {
    name: supplier.supplierName,
    address: formatAddress(supplier.supplierAddress),
    rows,
  };
}

function customerFields(
  invoice: InvoiceType,
  language: DocumentLanguage,
): { name: string; address: string; rows: Array<[string, string]> } {
  const customer = invoice.invoiceHead.customerInfo;
  if (!customer) return { name: '—', address: '', rows: [] };

  const rows: Array<[string, string]> = [];
  const vatData = customer.customerVatData;
  if (vatData?.customerTaxNumber) {
    rows.push([label('taxNumber', language), formatTaxNumber(vatData.customerTaxNumber)]);
  }
  if (vatData?.communityVatNumber) {
    rows.push([label('communityVatNumber', language), vatData.communityVatNumber]);
  }
  if (vatData?.thirdStateTaxId) {
    rows.push([label('thirdStateTaxId', language), vatData.thirdStateTaxId]);
  }
  if (customer.customerBankAccountNumber) {
    rows.push([label('bankAccount', language), customer.customerBankAccountNumber]);
  }

  // A private person is deliberately not named on the reported data.
  const name =
    customer.customerName ?? (customer.customerVatStatus === 'PRIVATE_PERSON' ? '—' : '');
  return { name, address: formatAddress(customer.customerAddress), rows };
}

function vatRateText(rate: VatRateType | undefined, language: DocumentLanguage): string {
  if (!rate) return '';
  if (rate.vatPercentage !== undefined) return formatPercentage(rate.vatPercentage, language);
  if (rate.vatContent !== undefined) return formatPercentage(rate.vatContent, language);
  if (rate.vatExemption) return `${label('exempt', language)} (${rate.vatExemption.case})`;
  if (rate.vatOutOfScope) return `${label('outOfScope', language)} (${rate.vatOutOfScope.case})`;
  if (rate.vatDomesticReverseCharge) return label('reverseCharge', language);
  if (rate.marginSchemeIndicator) return label('exempt', language);
  return '';
}

/** Whether a column holds a right-aligned number. */
const NUMERIC_COLUMN: Record<LineColumn, boolean> = {
  lineNumber: true,
  description: false,
  quantity: true,
  unit: false,
  unitPrice: true,
  net: true,
  vatRate: true,
  vatAmount: true,
  gross: true,
};

function columnHeader(column: LineColumn, currency: string, language: DocumentLanguage): string {
  switch (column) {
    case 'net':
      return `${label('netAmount', language)} (${currency})`;
    case 'vatRate':
      return label('vatRate', language);
    case 'vatAmount':
      return label('vatAmount', language);
    case 'gross':
      return label('grossAmount', language);
    case 'unitPrice':
      return label('unitPrice', language);
    default:
      return label(column, language);
  }
}

function columnCell(column: LineColumn, line: LineType, language: DocumentLanguage): string {
  const normal = line.lineAmountsNormal;
  const simplified = line.lineAmountsSimplified;
  switch (column) {
    case 'lineNumber':
      return String(line.lineNumber);
    case 'description':
      return line.lineDescription ?? '';
    case 'quantity':
      return line.quantity ? formatAmount(line.quantity, language, decimalsOf(line.quantity)) : '';
    case 'unit':
      return unitLabel(line.unitOfMeasure, line.unitOfMeasureOwn, language);
    case 'unitPrice':
      return line.unitPrice
        ? formatAmount(line.unitPrice, language, decimalsOf(line.unitPrice))
        : '';
    case 'net':
      return normal ? formatAmount(normal.lineNetAmountData.lineNetAmount, language) : '';
    case 'vatRate':
      return vatRateText(normal?.lineVatRate ?? simplified?.lineVatRate, language);
    case 'vatAmount':
      return normal?.lineVatData ? formatAmount(normal.lineVatData.lineVatAmount, language) : '';
    case 'gross': {
      const gross =
        normal?.lineGrossAmountData?.lineGrossAmountNormal ?? simplified?.lineGrossAmountSimplified;
      return gross ? formatAmount(gross, language) : '';
    }
  }
}

function renderLines(
  lines: LineType[],
  currency: string,
  language: DocumentLanguage,
  columns: LineColumn[],
): string {
  if (lines.length === 0) return '';

  const head = columns
    .map(
      (column) =>
        `<th${NUMERIC_COLUMN[column] ? ' class="num"' : ''}>${escapeHtml(columnHeader(column, currency, language))}</th>`,
    )
    .join('\n        ');

  const rows = lines
    .map((line) => {
      const cells = columns
        .map(
          (column) =>
            `<td${NUMERIC_COLUMN[column] ? ' class="num"' : ''}>${escapeHtml(columnCell(column, line, language))}</td>`,
        )
        .join('');
      return `<tr>${cells}</tr>`;
    })
    .join('\n      ');

  return `<table>
    <thead>
      <tr>
        ${head}
      </tr>
    </thead>
    <tbody>
      ${rows}
    </tbody>
  </table>`;
}

/** Keep a quantity's own precision rather than forcing two decimals. */
function decimalsOf(value: string): number {
  const fraction = value.split('.')[1];
  if (!fraction) return 0;
  return fraction.replace(/0+$/, '').length;
}

function renderTotals(
  invoice: InvoiceType,
  currency: string,
  language: DocumentLanguage,
  mode: 'full' | 'grossOnly' | 'none',
): string {
  if (mode === 'none') return '';
  const summary = invoice.invoiceSummary;
  const normal = summary.summaryNormal;
  const gross = summary.summaryGrossData;
  const rows: string[] = [];

  if (normal && mode === 'full') {
    rows.push(
      row(label('totalNet', language), formatAmount(normal.invoiceNetAmount, language), currency),
      row(label('totalVat', language), formatAmount(normal.invoiceVatAmount, language), currency),
    );
  }
  if (gross) {
    rows.push(
      `<tr class="grand"><td>${escapeHtml(label('totalGross', language))}</td>` +
        `<td class="num">${escapeHtml(formatAmount(gross.invoiceGrossAmount, language))}</td>` +
        `<td class="num">${escapeHtml(currency)}</td></tr>`,
    );
    if (currency !== 'HUF') {
      rows.push(
        row(label('inHuf', language), formatAmount(gross.invoiceGrossAmountHUF, language), 'HUF'),
      );
    }
  }
  if (rows.length === 0) return '';

  return `<div class="totals"><table><tbody>${rows.join('')}</tbody></table></div>`;
}

function row(name: string, value: string, currency: string): string {
  return (
    `<tr><td>${escapeHtml(name)}</td>` +
    `<td class="num">${escapeHtml(value)}</td>` +
    `<td class="num">${escapeHtml(currency)}</td></tr>`
  );
}

function renderVatSummary(
  invoice: InvoiceType,
  currency: string,
  language: DocumentLanguage,
): string {
  const byRate = invoice.invoiceSummary.summaryNormal?.summaryByVatRate ?? [];
  if (byRate.length < 2) return '';

  const rows = byRate
    .map(
      (entry) => `<tr>
        <td>${escapeHtml(vatRateText(entry.vatRate, language))}</td>
        <td class="num">${escapeHtml(formatAmount(entry.vatRateNetData.vatRateNetAmount, language))}</td>
        <td class="num">${escapeHtml(formatAmount(entry.vatRateVatData.vatRateVatAmount, language))}</td>
        <td class="num">${entry.vatRateGrossData ? escapeHtml(formatAmount(entry.vatRateGrossData.vatRateGrossAmount, language)) : ''}</td>
      </tr>`,
    )
    .join('\n      ');

  return `<section class="vat-summary">
    <h2>${escapeHtml(label('summaryByVatRate', language))} (${escapeHtml(currency)})</h2>
    <table>
      <thead>
        <tr>
          <th>${escapeHtml(label('vatRate', language))}</th>
          <th class="num">${escapeHtml(label('netAmount', language))}</th>
          <th class="num">${escapeHtml(label('vatAmount', language))}</th>
          <th class="num">${escapeHtml(label('grossAmount', language))}</th>
        </tr>
      </thead>
      <tbody>
      ${rows}
      </tbody>
    </table>
  </section>`;
}

function renderMarkings(
  markings: ReturnType<typeof deriveMarkings>,
  language: DocumentLanguage,
): string {
  if (markings.length === 0) return '';
  const items = markings
    .map(
      (marking) =>
        `<li>${escapeHtml(marking.text)}` +
        (marking.detail ? ` — ${escapeHtml(marking.detail)}` : '') +
        ` <span class="reference">(${escapeHtml(marking.reference)})</span></li>`,
    )
    .join('\n        ');
  return `<section class="markings">
    <h2>${escapeHtml(label('markings', language))}</h2>
    <ul>
        ${items}
    </ul>
  </section>`;
}
