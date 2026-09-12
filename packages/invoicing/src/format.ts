import { Decimal } from '@open-nav/core';

export type DocumentLanguage = 'hu' | 'en' | 'de';

/**
 * Format an exact decimal for display without going through a JavaScript
 * number.
 *
 * The amounts on an invoice are exact decimal strings precisely so they do
 * not lose precision; rendering them through `Number` to get thousands
 * separators would throw that away at the top of NAV's 18 digit range.
 */
export function formatAmount(
  value: string,
  language: DocumentLanguage,
  fractionDigits = 2,
): string {
  const amount = Decimal.from(value).round(fractionDigits);
  const text = amount.abs().toFixed(fractionDigits);
  const [whole = '0', fraction = ''] = text.split('.');

  // A non-breaking space, so a grouped amount never breaks across a line,
  // which is the Hungarian typographic convention for thousands. German groups
  // with a dot and decimalises with a comma; English is the plain 1,234.56.
  const groupSeparator = language === 'hu' ? '\u00a0' : language === 'de' ? '.' : ',';
  const decimalSeparator = language === 'en' ? '.' : ',';
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, groupSeparator);

  const sign = amount.isNegative() ? '-' : '';
  return fraction === '' ? `${sign}${grouped}` : `${sign}${grouped}${decimalSeparator}${fraction}`;
}

/** Format a VAT rate like `0.27` as a percentage. */
export function formatPercentage(value: string, language: DocumentLanguage): string {
  const percent = Decimal.from(value).multiply('100');
  const trimmed = percent
    .toString()
    .replace(/\.0+$/, '')
    .replace(/(\.\d*?)0+$/, '$1');
  // English uses a decimal point; Hungarian and German a comma.
  return `${language === 'en' ? trimmed : trimmed.replace('.', ',')}%`;
}

/** Dates are ISO in the data; Hungarian and German documents rewrite them. */
export function formatDate(value: string, language: DocumentLanguage): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  if (language === 'en') return value;
  const [year, month, day] = value.split('-');
  // German writes day-first with dots; Hungarian year-first with dots.
  if (language === 'de') return `${day}.${month}.${year}.`;
  return `${year}. ${month}. ${day}.`;
}

/** Compose a tax number from its parts, in the written form. */
export function formatTaxNumber(parts: {
  taxpayerId: string;
  vatCode?: string;
  countyCode?: string;
}): string {
  return [parts.taxpayerId, parts.vatCode, parts.countyCode].filter(Boolean).join('-');
}

/** Escape text for HTML. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
