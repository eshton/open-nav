import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { AddressType, InvoiceData, InvoiceType, LineType, VatRateType } from '@open-nav/core';
import { toHexColor, toMargins, toPoints } from './color.js';
import { formatAmount, formatDate, formatPercentage, formatTaxNumber } from './format.js';
import { documentTitle, label, paymentMethodLabel, unitLabel } from './labels.js';
import { deriveMarkings } from './markings.js';
import { resolveTheme, type ResolvedTheme } from './theme.js';
import type { RenderOptions } from './html.js';

/**
 * PDF output without a browser.
 *
 * pdfmake does the layout and pdfkit the serialisation, and the fonts pdfmake
 * bundles are Roboto — which covers Latin Extended-A, so `ő` and `ű` come out
 * right. That was the whole reason a browser was needed: the PDF core fonts
 * cannot represent those two characters, and Roboto embedded as a subset can.
 *
 * The output is smaller than a browser's and needs nothing installed. The
 * cost is a second layout: this is pdfmake's document model, not CSS, so it
 * follows the theme but will not match the HTML pixel for pixel.
 */

export class NativePdfError extends Error {}

/** The slice of pdfmake's API used here, declared because it ships no types. */
interface PdfmakeFonts {
  [family: string]: { normal: string; bold: string; italics: string; bolditalics: string };
}
interface PdfmakeInstance {
  addFonts(fonts: PdfmakeFonts): void;
  createPdf(definition: Record<string, unknown>): { getBuffer(): Promise<Buffer> };
  /** Decides whether a remote resource may be fetched. */
  setUrlAccessPolicy(callback: (url: string) => boolean): void;
  /** Decides whether a local path may be read. */
  setLocalAccessPolicy(callback: (path: string) => boolean): void;
}

/** A brand font for the PDF engine, as four files. */
export interface PdfFont {
  /** Family name referenced in the document. */
  name: string;
  normal: string;
  bold?: string;
  italics?: string;
  bolditalics?: string;
}

export interface NativePdfOptions extends RenderOptions {
  /** Replace Roboto with your own font files. */
  font?: PdfFont;
}

const require_ = createRequire(import.meta.url);

/** Locate the Roboto files inside the installed pdfmake package. */
function defaultFont(): PdfFont {
  const root = dirname(require_.resolve('pdfmake/package.json'));
  const dir = join(root, 'fonts', 'Roboto');
  const font: PdfFont = {
    name: 'Roboto',
    normal: join(dir, 'Roboto-Regular.ttf'),
    bold: join(dir, 'Roboto-Medium.ttf'),
    italics: join(dir, 'Roboto-Italic.ttf'),
    bolditalics: join(dir, 'Roboto-MediumItalic.ttf'),
  };
  if (!existsSync(font.normal)) {
    throw new NativePdfError(
      `pdfmake's bundled fonts were not found at ${dir}. Reinstall @open-nav/invoicing, ` +
        'or pass your own font with the font option.',
    );
  }
  return font;
}

function loadPdfmake(font: PdfFont): PdfmakeInstance {
  const pdfmake = require_('pdfmake') as PdfmakeInstance;

  const fontPaths = new Set(
    Object.entries(font)
      .filter(([style, path]) => style !== 'name' && typeof path === 'string')
      .map(([, path]) => path as string),
  );
  for (const path of fontPaths) {
    if (!existsSync(path)) throw new NativePdfError(`Font file not found: ${path}`);
  }

  // pdfmake will fetch remote resources and read arbitrary local files unless
  // told otherwise. An invoice document needs neither: images arrive as data
  // URIs and the only local reads are the fonts registered right here. So the
  // renderer refuses everything else rather than leaving a document able to
  // reach the network or the filesystem.
  pdfmake.setUrlAccessPolicy(() => false);
  pdfmake.setLocalAccessPolicy((path: string) => fontPaths.has(path));

  pdfmake.addFonts({
    [font.name]: {
      normal: font.normal,
      bold: font.bold ?? font.normal,
      italics: font.italics ?? font.normal,
      bolditalics: font.bolditalics ?? font.bold ?? font.normal,
    },
  });
  return pdfmake;
}

/** Render an invoice to PDF bytes without a browser. */
export async function renderInvoicePdfNative(
  document: InvoiceData,
  options: NativePdfOptions = {},
): Promise<Buffer> {
  const theme = resolveTheme(options.theme);
  const font = options.font ?? defaultFont();
  const pdfmake = loadPdfmake(font);
  const definition = buildDefinition(document, theme, font, options);
  return pdfmake.createPdf(definition).getBuffer();
}

interface Palette {
  accent: string;
  ink: string;
  muted: string;
  panel: string;
  rule: string;
}

function buildDefinition(
  document: InvoiceData,
  theme: ResolvedTheme,
  font: PdfFont,
  options: NativePdfOptions,
): Record<string, unknown> {
  const language = options.language ?? 'hu';
  const base = toPoints(theme.baseFontSize, 10);
  const palette: Palette = {
    accent: toHexColor(theme.accentColor, '#16181d'),
    ink: toHexColor(theme.inkColor, '#16181d'),
    muted: toHexColor(theme.mutedColor, '#5b6270'),
    panel: toHexColor(theme.panelColor, '#f4f5f8'),
    rule: toHexColor(theme.borderColor, '#c9cdd6'),
  };

  const invoices = document.invoiceMain.invoice
    ? [document.invoiceMain.invoice]
    : (document.invoiceMain.batchInvoice ?? []).map((entry) => entry.invoice);

  const content: unknown[] = [];
  for (const [index, invoice] of invoices.entries()) {
    if (index > 0) content.push({ text: '', pageBreak: 'before' });
    content.push(...invoiceContent(document, invoice, theme, palette, base, language, options));
  }

  const { pageSize, pageOrientation } = pageSetup(theme);

  return {
    pageSize,
    ...(pageOrientation ? { pageOrientation } : {}),
    pageMargins: toMargins(theme.pageMargin, 40),
    defaultStyle: { font: font.name, fontSize: base, color: palette.ink },
    info: { title: document.invoiceNumber },
    content,
    footer: footerFactory(theme, palette, base, language, options),
  };
}

function pageSetup(theme: ResolvedTheme): {
  pageSize: string | { width: number; height: number };
  pageOrientation?: string;
} {
  const parts = theme.pageSize.trim().split(/\s+/);
  if (parts.length === 2 && /[a-z]{2}$/.test(parts[0]!) && /^[0-9.]/.test(parts[0]!)) {
    return {
      pageSize: { width: toPoints(parts[0]!, 595), height: toPoints(parts[1]!, 842) },
    };
  }
  const [name, orientation] = parts;
  return {
    pageSize: (name ?? 'A4').toUpperCase(),
    ...(orientation ? { pageOrientation: orientation.toLowerCase() } : {}),
  };
}

function footerFactory(
  theme: ResolvedTheme,
  palette: Palette,
  base: number,
  language: 'hu' | 'en',
  options: NativePdfOptions,
) {
  const showProvenance = options.provenanceNote ?? theme.provenanceNote;
  const lines = [...theme.footerLines, ...(showProvenance ? [label('notReported', language)] : [])];
  const margins = toMargins(theme.pageMargin, 40);

  return (currentPage: number, pageCount: number): Record<string, unknown> => ({
    margin: [margins[0], 6, margins[2], 0],
    columns: [
      {
        stack: lines.map((line) => ({ text: line })),
        fontSize: base * 0.8,
        color: palette.muted,
      },
      {
        // Page numbers matter once an invoice runs to several pages.
        text: pageCount > 1 ? `${currentPage} / ${pageCount}` : '',
        alignment: 'right',
        width: 60,
        fontSize: base * 0.8,
        color: palette.muted,
      },
    ],
  });
}

function invoiceContent(
  document: InvoiceData,
  invoice: InvoiceType,
  theme: ResolvedTheme,
  palette: Palette,
  base: number,
  language: 'hu' | 'en',
  options: NativePdfOptions,
): unknown[] {
  const detail = invoice.invoiceHead.invoiceDetail;
  const markings = deriveMarkings(invoice, language);
  const isModification = invoice.invoiceReference !== undefined;
  const content: unknown[] = [];

  // --- header -----------------------------------------------------------
  const brand: unknown[] = [];
  if (theme.logo?.src.startsWith('data:image/')) {
    // pdfmake reads a data URI directly; an http URL it cannot fetch, and an
    // SVG it cannot rasterise, so both are skipped rather than failing.
    if (!theme.logo.src.startsWith('data:image/svg')) {
      brand.push({
        image: theme.logo.src,
        ...(theme.logo.width ? { width: toPoints(theme.logo.width, 120) } : { fit: [170, 60] }),
        margin: [0, 0, 0, 6],
      });
    }
  }
  brand.push({
    text: documentTitle(detail.invoiceCategory, isModification, language),
    fontSize: base * 2,
    bold: true,
    color: palette.accent,
    characterSpacing: base * 0.08,
  });
  if (markings.length > 0) {
    brand.push({
      text: markings.map((marking) => marking.text).join(' · '),
      fontSize: base * 0.9,
      color: palette.muted,
      margin: [0, 3, 0, 0],
    });
  }

  content.push({
    columns: [
      { width: '*', stack: brand },
      {
        width: 'auto',
        table: { body: metaRows(document, invoice, language) },
        layout: noBorders(),
        fontSize: base * 0.95,
      },
    ],
    columnGap: 20,
  });

  // --- parties ----------------------------------------------------------
  content.push({
    margin: [0, 16, 0, 0],
    columns: [
      partyBox(label('supplier', language), supplierLines(invoice, language, theme), palette, base),
      partyBox(label('customer', language), customerLines(invoice, language), palette, base),
    ],
    columnGap: 14,
  });

  // --- lines ------------------------------------------------------------
  const lines = invoice.invoiceLines?.line ?? [];
  if (lines.length > 0) {
    content.push({
      margin: [0, 16, 0, 0],
      table: {
        headerRows: 1,
        // The header repeats on every page, which is what makes a long
        // invoice readable in print.
        widths: ['auto', '*', 'auto', 'auto', 'auto', 'auto', 'auto', 'auto', 'auto'],
        body: [
          lineHeader(detail.currencyCode, language, palette, base),
          ...lines.map((line) => lineRow(line, language)),
        ],
      },
      layout: tableLayout(palette, theme.zebraRows),
      fontSize: base * 0.9,
    });
  }

  // --- totals -----------------------------------------------------------
  const totals = totalRows(invoice, language, palette, base);
  if (totals.length > 0) {
    content.push({
      margin: [0, 14, 0, 0],
      columns: [
        { width: '*', text: '' },
        { width: 'auto', table: { body: totals }, layout: noBorders(), fontSize: base * 0.95 },
      ],
    });
  }

  // --- VAT summary ------------------------------------------------------
  const byRate = invoice.invoiceSummary.summaryNormal?.summaryByVatRate ?? [];
  if (byRate.length > 1) {
    content.push(
      sectionHeading(label('summaryByVatRate', language), detail.currencyCode, palette, base),
      {
        table: {
          headerRows: 1,
          widths: ['*', 'auto', 'auto', 'auto'],
          body: [
            [
              headerCell(label('vatRate', language), palette, base),
              headerCell(label('netAmount', language), palette, base, 'right'),
              headerCell(label('vatAmount', language), palette, base, 'right'),
              headerCell(label('grossAmount', language), palette, base, 'right'),
            ],
            ...byRate.map((entry) => [
              { text: vatRateText(entry.vatRate, language) },
              num(formatAmount(entry.vatRateNetData.vatRateNetAmount, language)),
              num(formatAmount(entry.vatRateVatData.vatRateVatAmount, language)),
              num(
                entry.vatRateGrossData
                  ? formatAmount(entry.vatRateGrossData.vatRateGrossAmount, language)
                  : '',
              ),
            ]),
          ],
        },
        layout: tableLayout(palette, theme.zebraRows),
        fontSize: base * 0.9,
      },
    );
  }

  // --- statutory markings ----------------------------------------------
  if (markings.length > 0) {
    content.push(sectionHeading(label('markings', language), undefined, palette, base), {
      table: {
        widths: ['*'],
        body: [
          [
            {
              fillColor: palette.panel,
              margin: [8, 6, 8, 6],
              stack: markings.map((marking) => ({
                text: [
                  { text: `• ${marking.text}` },
                  ...(marking.detail ? [{ text: ` — ${marking.detail}` }] : []),
                  { text: `  (${marking.reference})`, color: palette.muted, fontSize: base * 0.85 },
                ],
                margin: [0, 0, 0, 2],
              })),
            },
          ],
        ],
      },
      layout: noBorders(),
      fontSize: base * 0.9,
    });
  }

  if (options.note) {
    content.push({ text: options.note, margin: [0, 12, 0, 0], fontSize: base * 0.9 });
  }

  return content;
}

function metaRows(document: InvoiceData, invoice: InvoiceType, language: 'hu' | 'en'): unknown[][] {
  const detail = invoice.invoiceHead.invoiceDetail;
  const rows: Array<[string, string]> = [
    [label('invoiceNumber', language), document.invoiceNumber],
    [label('issueDate', language), formatDate(document.invoiceIssueDate, language)],
  ];
  if (detail.invoiceDeliveryDate) {
    rows.push([label('deliveryDate', language), formatDate(detail.invoiceDeliveryDate, language)]);
  }
  if (detail.invoiceDeliveryPeriodStart && detail.invoiceDeliveryPeriodEnd) {
    rows.push([
      label('deliveryPeriod', language),
      `${formatDate(detail.invoiceDeliveryPeriodStart, language)} – ${formatDate(detail.invoiceDeliveryPeriodEnd, language)}`,
    ]);
  }
  if (detail.paymentDate) {
    rows.push([label('paymentDate', language), formatDate(detail.paymentDate, language)]);
  }
  if (detail.paymentMethod) {
    rows.push([
      label('paymentMethod', language),
      paymentMethodLabel(detail.paymentMethod, language),
    ]);
  }
  rows.push([label('currency', language), detail.currencyCode]);
  if (detail.exchangeRate && detail.currencyCode !== 'HUF') {
    rows.push([
      label('exchangeRate', language),
      `${detail.exchangeRate} HUF/${detail.currencyCode}`,
    ]);
  }
  if (invoice.invoiceReference) {
    rows.push([
      label('originalInvoiceNumber', language),
      invoice.invoiceReference.originalInvoiceNumber,
    ]);
  }

  return rows.map(([name, value]) => [
    { text: `${name}:`, alignment: 'right' },
    { text: value, alignment: 'right', bold: true },
  ]);
}

function partyBox(
  heading: string,
  lines: { name: string; address: string; rows: Array<[string, string]>; contact: string[] },
  palette: Palette,
  base: number,
): unknown {
  const stack: unknown[] = [
    {
      text: heading.toUpperCase(),
      fontSize: base * 0.8,
      bold: true,
      color: palette.muted,
      characterSpacing: base * 0.1,
    },
    { text: lines.name, fontSize: base * 1.1, bold: true, margin: [0, 3, 0, 1] },
  ];
  if (lines.address) stack.push({ text: lines.address, fontSize: base * 0.9 });
  if (lines.rows.length > 0) {
    stack.push({
      margin: [0, 3, 0, 0],
      table: {
        body: lines.rows.map(([key, value]) => [
          { text: key, color: palette.muted },
          { text: value },
        ]),
      },
      layout: noBorders(),
      fontSize: base * 0.9,
    });
  }
  if (lines.contact.length > 0) {
    stack.push({
      margin: [0, 3, 0, 0],
      stack: lines.contact.map((line) => ({ text: line })),
      fontSize: base * 0.9,
      color: palette.muted,
    });
  }

  return {
    width: '*',
    table: { widths: ['*'], body: [[{ stack, margin: [8, 6, 8, 6] }]] },
    layout: boxLayout(palette),
  };
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

function supplierLines(invoice: InvoiceType, language: 'hu' | 'en', theme: ResolvedTheme) {
  const supplier = invoice.invoiceHead.supplierInfo;
  const rows: Array<[string, string]> = [
    [label('taxNumber', language), formatTaxNumber(supplier.supplierTaxNumber)],
  ];
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
    contact: theme.issuerContact,
  };
}

function customerLines(invoice: InvoiceType, language: 'hu' | 'en') {
  const customer = invoice.invoiceHead.customerInfo;
  if (!customer) return { name: '—', address: '', rows: [], contact: [] };

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

  return {
    // A private person is deliberately not named in the reported data.
    name: customer.customerName ?? '—',
    address: formatAddress(customer.customerAddress),
    rows,
    contact: [],
  };
}

function vatRateText(rate: VatRateType | undefined, language: 'hu' | 'en'): string {
  if (!rate) return '';
  if (rate.vatPercentage !== undefined) return formatPercentage(rate.vatPercentage, language);
  if (rate.vatContent !== undefined) return formatPercentage(rate.vatContent, language);
  if (rate.vatExemption) return `${label('exempt', language)} (${rate.vatExemption.case})`;
  if (rate.vatOutOfScope) return `${label('outOfScope', language)} (${rate.vatOutOfScope.case})`;
  if (rate.vatDomesticReverseCharge) return label('reverseCharge', language);
  if (rate.marginSchemeIndicator) return label('exempt', language);
  return '';
}

function lineHeader(
  currency: string,
  language: 'hu' | 'en',
  palette: Palette,
  base: number,
): unknown[] {
  return [
    headerCell(label('lineNumber', language), palette, base, 'right'),
    headerCell(label('description', language), palette, base),
    headerCell(label('quantity', language), palette, base, 'right'),
    headerCell(label('unit', language), palette, base),
    headerCell(label('unitPrice', language), palette, base, 'right'),
    headerCell(`${label('netAmount', language)} (${currency})`, palette, base, 'right'),
    headerCell(label('vatRate', language), palette, base, 'right'),
    headerCell(label('vatAmount', language), palette, base, 'right'),
    headerCell(label('grossAmount', language), palette, base, 'right'),
  ];
}

function lineRow(line: LineType, language: 'hu' | 'en'): unknown[] {
  const normal = line.lineAmountsNormal;
  const simplified = line.lineAmountsSimplified;
  const rate = normal?.lineVatRate ?? simplified?.lineVatRate;
  const gross =
    normal?.lineGrossAmountData?.lineGrossAmountNormal ?? simplified?.lineGrossAmountSimplified;

  return [
    num(String(line.lineNumber)),
    { text: line.lineDescription ?? '' },
    num(line.quantity ? formatAmount(line.quantity, language, decimalsOf(line.quantity)) : ''),
    { text: unitLabel(line.unitOfMeasure, line.unitOfMeasureOwn, language) },
    num(line.unitPrice ? formatAmount(line.unitPrice, language, decimalsOf(line.unitPrice)) : ''),
    num(normal ? formatAmount(normal.lineNetAmountData.lineNetAmount, language) : ''),
    num(vatRateText(rate, language)),
    num(normal?.lineVatData ? formatAmount(normal.lineVatData.lineVatAmount, language) : ''),
    num(gross ? formatAmount(gross, language) : ''),
  ];
}

/** Keep a quantity's own precision rather than forcing two decimals. */
function decimalsOf(value: string): number {
  const fraction = value.split('.')[1];
  return fraction ? fraction.replace(/0+$/, '').length : 0;
}

function totalRows(
  invoice: InvoiceType,
  language: 'hu' | 'en',
  palette: Palette,
  base: number,
): unknown[][] {
  const summary = invoice.invoiceSummary;
  const currency = invoice.invoiceHead.invoiceDetail.currencyCode;
  const rows: unknown[][] = [];

  if (summary.summaryNormal) {
    rows.push(
      totalRow(
        label('totalNet', language),
        formatAmount(summary.summaryNormal.invoiceNetAmount, language),
        currency,
      ),
      totalRow(
        label('totalVat', language),
        formatAmount(summary.summaryNormal.invoiceVatAmount, language),
        currency,
      ),
    );
  }
  if (summary.summaryGrossData) {
    rows.push([
      {
        text: label('totalGross', language),
        bold: true,
        fontSize: base * 1.15,
        color: palette.accent,
        margin: [0, 4, 0, 0],
        border: [false, true, false, false],
      },
      {
        text: formatAmount(summary.summaryGrossData.invoiceGrossAmount, language),
        alignment: 'right',
        bold: true,
        fontSize: base * 1.15,
        color: palette.accent,
        margin: [0, 4, 0, 0],
        border: [false, true, false, false],
      },
      {
        text: currency,
        alignment: 'right',
        bold: true,
        fontSize: base * 1.15,
        color: palette.accent,
        margin: [0, 4, 0, 0],
        border: [false, true, false, false],
      },
    ]);
    if (currency !== 'HUF') {
      rows.push(
        totalRow(
          label('inHuf', language),
          formatAmount(summary.summaryGrossData.invoiceGrossAmountHUF, language),
          'HUF',
        ),
      );
    }
  }
  return rows;
}

function totalRow(name: string, value: string, currency: string): unknown[] {
  return [
    { text: name },
    { text: value, alignment: 'right' },
    { text: currency, alignment: 'right' },
  ];
}

function sectionHeading(
  text: string,
  suffix: string | undefined,
  palette: Palette,
  base: number,
): unknown {
  return {
    text: `${text.toUpperCase()}${suffix ? ` (${suffix})` : ''}`,
    fontSize: base * 0.8,
    bold: true,
    color: palette.muted,
    characterSpacing: base * 0.1,
    margin: [0, 16, 0, 4],
  };
}

function headerCell(
  text: string,
  palette: Palette,
  base: number,
  alignment: 'left' | 'right' = 'left',
): unknown {
  return {
    text: text.toUpperCase(),
    bold: true,
    fontSize: base * 0.8,
    color: palette.muted,
    alignment,
  };
}

function num(text: string): unknown {
  return { text, alignment: 'right', noWrap: true };
}

/** Horizontal rules only, matching the HTML document's restraint. */
function tableLayout(palette: Palette, zebra: boolean): Record<string, unknown> {
  return {
    hLineWidth: (index: number, node: { table: { body: unknown[] } }) =>
      index === 0 || index === 1 || index === node.table.body.length ? 0.8 : 0.4,
    vLineWidth: () => 0,
    hLineColor: () => palette.rule,
    fillColor: (rowIndex: number) =>
      zebra && rowIndex > 0 && rowIndex % 2 === 0 ? palette.panel : null,
    paddingLeft: () => 4,
    paddingRight: () => 4,
    paddingTop: () => 4,
    paddingBottom: () => 4,
  };
}

function boxLayout(palette: Palette): Record<string, unknown> {
  return {
    hLineWidth: () => 0.6,
    vLineWidth: () => 0.6,
    hLineColor: () => palette.rule,
    vLineColor: () => palette.rule,
    paddingLeft: () => 0,
    paddingRight: () => 0,
    paddingTop: () => 0,
    paddingBottom: () => 0,
  };
}

function noBorders(): Record<string, unknown> {
  return {
    hLineWidth: () => 0,
    vLineWidth: () => 0,
    paddingLeft: (index: number) => (index === 0 ? 0 : 6),
    paddingRight: () => 0,
    paddingTop: () => 1,
    paddingBottom: () => 1,
  };
}
