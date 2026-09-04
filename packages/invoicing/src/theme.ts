import { readFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';

/**
 * Visual configuration for the invoice document.
 *
 * Every field is optional; what is left out falls back to a restrained
 * default that prints well in black and white. Values that end up inside the
 * stylesheet are validated rather than interpolated blindly — a theme is
 * configuration, but configuration is still input.
 */
export interface InvoiceTheme {
  /** Accent for headings, rules and the total. */
  accentColor?: string;
  /** Body text colour. */
  inkColor?: string;
  /** Secondary text: labels, references, the footer. */
  mutedColor?: string;
  /** Background of the markings panel. */
  panelColor?: string;
  /** Rules and borders. */
  borderColor?: string;

  /** CSS font stack. Give a real fallback chain; a PDF converter needs it. */
  fontFamily?: string;
  /** Base size, as a CSS length. Everything else scales from it. */
  baseFontSize?: string;

  /** Page size for `@page`, e.g. `A4` or `Letter`. */
  pageSize?: string;
  /** Page margin for `@page`, e.g. `16mm 14mm`. */
  pageMargin?: string;

  /** Logo shown in the header. Use `embedImage` to inline a local file. */
  logo?: InvoiceLogo;

  /** Extra lines in the supplier block: phone, email, web, registration. */
  issuerContact?: string[];
  /** Lines printed in the footer, e.g. payment terms or company details. */
  footerLines?: string[];

  /** Tint alternate table rows. Off by default; it prints heavier. */
  zebraRows?: boolean;
  /** Show the "rendered from reported data" note. Defaults to true. */
  provenanceNote?: boolean;

  /** Appended verbatim after the generated stylesheet. The escape hatch. */
  customCss?: string;
}

export interface InvoiceLogo {
  /**
   * Image source: a `data:` URI, or an absolute URL.
   *
   * Prefer a data URI. An external URL leaves the document dependent on the
   * network, which defeats archiving it as a single file and can quietly
   * produce a logo-less PDF.
   */
  src: string;
  /** Rendered width as a CSS length. Height follows the aspect ratio. */
  width?: string;
  /** Alternative text, for accessibility and for a failed image. */
  alt?: string;
}

export interface ResolvedTheme extends Required<Omit<InvoiceTheme, 'logo' | 'customCss'>> {
  logo?: InvoiceLogo;
  customCss?: string;
}

export const DEFAULT_THEME: ResolvedTheme = {
  accentColor: '#16181d',
  inkColor: '#16181d',
  mutedColor: '#5b6270',
  panelColor: '#f4f5f8',
  borderColor: '#c9cdd6',
  fontFamily: '"Helvetica Neue", Arial, "Liberation Sans", sans-serif',
  baseFontSize: '10pt',
  pageSize: 'A4',
  pageMargin: '16mm 14mm',
  issuerContact: [],
  footerLines: [],
  zebraRows: false,
  provenanceNote: true,
};

export class ThemeError extends Error {}

/** Colours we accept: hex, rgb(), rgba(), hsl(), hsla(), or a CSS keyword. */
const COLOR = /^(#[0-9a-fA-F]{3,8}|(rgb|hsl)a?\([0-9.,%\s/deg]+\)|[a-zA-Z]{3,20})$/;
/** Lengths and simple length lists, e.g. `10pt` or `16mm 14mm`. */
const LENGTH_LIST =
  /^[0-9.]+(px|pt|pc|mm|cm|in|em|rem|%)?( +[0-9.]+(px|pt|pc|mm|cm|in|em|rem|%)?){0,3}$/;
/** Page sizes: a keyword, optionally with an orientation, or two lengths. */
const PAGE_SIZE =
  /^([A-Za-z][A-Za-z0-9]{0,10}( +(portrait|landscape))?|[0-9.]+[a-z]{2} +[0-9.]+[a-z]{2})$/;
/**
 * A font stack: names, quotes, commas, spaces, hyphens.
 *
 * Parentheses are excluded deliberately. No font name contains one, and
 * allowing them would admit `url(...)`, which is how a stylesheet is made to
 * fetch something.
 */
const FONT_STACK = /^[-A-Za-z0-9 ,."']+$/;

function check(value: string, pattern: RegExp, field: string, expected: string): string {
  const trimmed = value.trim();
  if (!pattern.test(trimmed)) {
    throw new ThemeError(
      `theme.${field}: ${JSON.stringify(value)} is not ${expected}. ` +
        `Values reach the stylesheet, so they are checked rather than trusted.`,
    );
  }
  return trimmed;
}

/** Fill in the defaults, validating everything that lands in the CSS. */
export function resolveTheme(theme: InvoiceTheme = {}): ResolvedTheme {
  const merged: ResolvedTheme = { ...DEFAULT_THEME, ...stripUndefined(theme) };

  for (const field of [
    'accentColor',
    'inkColor',
    'mutedColor',
    'panelColor',
    'borderColor',
  ] as const) {
    merged[field] = check(merged[field], COLOR, field, 'a CSS colour');
  }
  merged.baseFontSize = check(merged.baseFontSize, LENGTH_LIST, 'baseFontSize', 'a CSS length');
  merged.pageMargin = check(merged.pageMargin, LENGTH_LIST, 'pageMargin', 'a CSS length');
  merged.pageSize = check(merged.pageSize, PAGE_SIZE, 'pageSize', 'a CSS page size');
  merged.fontFamily = check(merged.fontFamily, FONT_STACK, 'fontFamily', 'a CSS font stack');

  if (merged.logo) {
    const src = merged.logo.src.trim();
    if (!/^(data:image\/[a-z+.-]+;base64,[A-Za-z0-9+/=]+|https?:\/\/\S+)$/.test(src)) {
      throw new ThemeError(
        'theme.logo.src must be a data: image URI or an http(s) URL. ' +
          'Use embedImage() to inline a local file.',
      );
    }
    merged.logo = {
      src,
      ...(merged.logo.width
        ? { width: check(merged.logo.width, LENGTH_LIST, 'logo.width', 'a CSS length') }
        : {}),
      ...(merged.logo.alt ? { alt: merged.logo.alt } : {}),
    };
  }

  return merged;
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>;
}

const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

/** Largest logo we inline, before base64 expansion. */
export const MAX_LOGO_BYTES = 2 * 1024 * 1024;

/**
 * Read an image and return it as a `data:` URI.
 *
 * Inlining keeps the document self-contained, which is what makes it archive
 * as one file and print the same offline.
 */
export function embedImage(filePath: string, contents?: Buffer): string {
  const extension = extname(filePath).toLowerCase();
  const mime = MIME_TYPES[extension];
  if (!mime) {
    throw new ThemeError(
      `Unsupported image type ${extension || filePath}. Supported: ${Object.keys(MIME_TYPES).join(', ')}`,
    );
  }
  const bytes = contents ?? readFileSync(filePath);
  if (bytes.length > MAX_LOGO_BYTES) {
    throw new ThemeError(
      `${filePath} is ${Math.round(bytes.length / 1024)} kB; the limit is ${MAX_LOGO_BYTES / 1024} kB. ` +
        `A logo this large bloats every document it appears in.`,
    );
  }
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

/**
 * Load a theme from a JSON file.
 *
 * A `logoFile` field is read relative to the theme file and inlined, so a
 * theme can be checked in next to its logo and stay portable.
 */
export function loadTheme(
  filePath: string,
  io: { readFile?: (path: string) => string; readBinary?: (path: string) => Buffer } = {},
): InvoiceTheme {
  const readFile = io.readFile ?? ((path: string) => readFileSync(path, 'utf8'));

  let parsed: InvoiceTheme & { logoFile?: string };
  try {
    parsed = JSON.parse(readFile(filePath)) as InvoiceTheme & { logoFile?: string };
  } catch (cause) {
    throw new ThemeError(`${filePath} is not valid JSON: ${(cause as Error).message}`);
  }

  const { logoFile, ...theme } = parsed;
  if (logoFile) {
    const imagePath = resolve(dirname(filePath), logoFile);
    const readBinary = io.readBinary ?? ((path: string) => readFileSync(path));
    theme.logo = {
      ...theme.logo,
      src: embedImage(imagePath, readBinary(imagePath)),
    };
  }
  return theme;
}

/** Build the document stylesheet from a resolved theme. */
export function buildStyles(theme: ResolvedTheme): string {
  return `<style>
  @page { size: ${theme.pageSize}; margin: ${theme.pageMargin}; }
  :root {
    --accent: ${theme.accentColor};
    --ink: ${theme.inkColor};
    --muted: ${theme.mutedColor};
    --rule: ${theme.borderColor};
    --panel: ${theme.panelColor};
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    color: var(--ink);
    font: ${theme.baseFontSize}/1.45 ${theme.fontFamily};
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .invoice { max-width: 190mm; margin: 0 auto; padding: 8mm 0; }
  .page-break { page-break-after: always; }

  header { display: flex; justify-content: space-between; align-items: flex-start; gap: 12mm; }
  .brand { display: flex; flex-direction: column; gap: 3mm; }
  .logo { display: block; max-width: 70mm; max-height: 26mm; }
  h1 { margin: 0; font-size: 2em; letter-spacing: 0.08em; font-weight: 700; color: var(--accent); }
  .subtitle { color: var(--muted); font-size: 0.9em; margin-top: 2mm; }
  .meta { text-align: right; font-size: 0.95em; min-width: 64mm; }
  .meta div { margin-bottom: 1mm; }
  .meta .value { font-weight: 700; white-space: nowrap; }

  .parties { display: flex; gap: 6mm; margin: 7mm 0; }
  .party { flex: 1; border: 1px solid var(--rule); border-radius: 2mm; padding: 4mm; }
  .party h2 {
    margin: 0 0 2mm; font-size: 0.8em; text-transform: uppercase;
    letter-spacing: 0.1em; color: var(--muted); font-weight: 700;
  }
  .party .name { font-weight: 700; font-size: 1.1em; margin-bottom: 1mm; }
  .party .address { font-size: 0.9em; margin-bottom: 1.5mm; }
  .party dl { margin: 2mm 0 0; display: grid; grid-template-columns: auto 1fr; gap: 0.6mm 3mm; font-size: 0.9em; }
  .party dt { color: var(--muted); }
  .party dd { margin: 0; }
  .party .contact { margin-top: 2mm; font-size: 0.9em; color: var(--muted); }

  table { width: 100%; border-collapse: collapse; font-size: 0.9em; }
  thead th {
    text-align: left; font-size: 0.8em; text-transform: uppercase; letter-spacing: 0.06em;
    color: var(--muted); border-bottom: 1px solid var(--rule); padding: 2mm 1.5mm;
  }
  tbody td { padding: 2mm 1.5mm; border-bottom: 1px solid var(--rule); vertical-align: top; }
  ${theme.zebraRows ? 'tbody tr:nth-child(even) td { background: var(--panel); }' : ''}
  .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }

  .totals { display: flex; justify-content: flex-end; margin-top: 5mm; }
  .totals table { width: auto; min-width: 80mm; }
  .totals td { padding: 1.5mm 2mm; border: none; background: none; }
  .totals .grand td {
    border-top: 1.5px solid var(--accent); color: var(--accent);
    font-weight: 700; font-size: 1.15em; padding-top: 2.5mm;
  }

  .vat-summary { margin-top: 6mm; }
  .vat-summary h2, .markings h2 {
    font-size: 0.8em; text-transform: uppercase; letter-spacing: 0.1em;
    color: var(--muted); margin: 0 0 2mm; font-weight: 700;
  }
  .markings { margin-top: 6mm; background: var(--panel); border-radius: 2mm; padding: 4mm; }
  .markings ul { margin: 0; padding-left: 4mm; }
  .markings li { margin-bottom: 1mm; }
  .markings .reference { color: var(--muted); font-size: 0.85em; }
  .note { margin-top: 5mm; font-size: 0.9em; }
  footer {
    margin-top: 8mm; color: var(--muted); font-size: 0.8em;
    border-top: 1px solid var(--rule); padding-top: 2mm;
  }
  footer div { margin-bottom: 0.8mm; }
${theme.customCss ? `\n  /* customCss */\n${theme.customCss}\n` : ''}</style>`;
}
