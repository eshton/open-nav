/**
 * Hungarian tax number checks.
 *
 * A tax number is eleven digits in three parts: an eight digit core
 * (törzsszám) whose last digit is a check digit, a one digit VAT code
 * (áfakód), and a two digit county code (megyekód). NAV's schemas carry the
 * three parts separately, in `taxpayerId`, `vatCode` and `countyCode`.
 */

/** Weights applied to the first seven digits of the core number. */
const CHECK_WEIGHTS = [9, 7, 3, 1, 9, 7, 3] as const;

/**
 * County codes NAV issues.
 *
 * This set is **not** in the XSD, which only constrains the field to two
 * digits, so it is best-effort and is reported as a warning rather than an
 * error. Budapest and Pest county use 41 to 44; 51 is used for taxpayers
 * registered by the large taxpayers directorate.
 */
const COUNTY_CODES = new Set([
  ...range(2, 20), // the counties, alphabetically
  ...range(22, 44), // remaining counties plus the capital
  51,
]);

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, index) => from + index);
}

/**
 * Whether the check digit of an eight digit core tax number is consistent.
 *
 * Verified against the real tax numbers in NAV's published samples. Note that
 * two of the four tax numbers those samples use (`98765432`, `87654321`) are
 * obvious placeholders and do *not* satisfy the check — evidence that NAV
 * validates a tax number against its taxpayer registry rather than
 * arithmetically. Treat a failure here as a likely typo, and use
 * `queryTaxpayer` when you need an authoritative answer.
 */
export function isValidTaxpayerId(taxpayerId: string): boolean {
  if (!/^\d{8}$/.test(taxpayerId)) return false;
  const sum = CHECK_WEIGHTS.reduce(
    (total, weight, index) => total + Number(taxpayerId[index]) * weight,
    0,
  );
  return (10 - (sum % 10)) % 10 === Number(taxpayerId[7]);
}

/** The check digit an eight digit core tax number should end with. */
export function taxpayerIdCheckDigit(firstSevenDigits: string): number {
  if (!/^\d{7}$/.test(firstSevenDigits)) {
    throw new Error(`Expected seven digits, got ${JSON.stringify(firstSevenDigits)}`);
  }
  const sum = CHECK_WEIGHTS.reduce(
    (total, weight, index) => total + Number(firstSevenDigits[index]) * weight,
    0,
  );
  return (10 - (sum % 10)) % 10;
}

/** Whether a VAT code is one NAV defines. */
export function isValidVatCode(vatCode: string): boolean {
  return /^[1-5]$/.test(vatCode);
}

/** Whether a county code is one NAV issues. Best-effort; see COUNTY_CODES. */
export function isValidCountyCode(countyCode: string): boolean {
  return /^\d{2}$/.test(countyCode) && COUNTY_CODES.has(Number(countyCode));
}

export interface ParsedTaxNumber {
  taxpayerId: string;
  vatCode?: string;
  countyCode?: string;
}

/**
 * Split an eleven digit tax number into the three parts NAV's schema wants.
 *
 * Accepts the common written forms — `12345678-2-41`, `12345678 2 41` and
 * `12345678241` — because that is how the number appears on paper, and
 * pasting it whole into `taxpayerId` is the mistake this avoids.
 */
export function parseTaxNumber(input: string): ParsedTaxNumber {
  const digits = input.replace(/[\s-]/g, '');
  if (/^\d{8}$/.test(digits)) return { taxpayerId: digits };
  if (/^\d{11}$/.test(digits)) {
    return {
      taxpayerId: digits.slice(0, 8),
      vatCode: digits.slice(8, 9),
      countyCode: digits.slice(9, 11),
    };
  }
  throw new Error(`Expected an 8 or 11 digit Hungarian tax number, got ${JSON.stringify(input)}`);
}
