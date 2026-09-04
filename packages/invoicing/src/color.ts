/**
 * Colour conversion for the PDF engine.
 *
 * A browser accepts every CSS colour form; PDF does not — pdfkit understands
 * hex and the CSS colour keywords. Converting here means a theme behaves the
 * same whichever engine renders it, rather than silently losing a colour in
 * one of them.
 */

/** CSS colour keywords, kept to the ones a document is plausibly styled with. */
const KEYWORDS: Record<string, string> = {
  black: '#000000',
  white: '#ffffff',
  red: '#ff0000',
  green: '#008000',
  blue: '#0000ff',
  navy: '#000080',
  teal: '#008080',
  olive: '#808000',
  purple: '#800080',
  maroon: '#800000',
  gray: '#808080',
  grey: '#808080',
  silver: '#c0c0c0',
  orange: '#ffa500',
  yellow: '#ffff00',
  rebeccapurple: '#663399',
  transparent: '#ffffff',
};

/**
 * Convert any accepted theme colour to `#rrggbb`.
 *
 * Alpha is dropped: PDF has no per-colour alpha in this position, and a
 * silently half-transparent rule is worse than an opaque one.
 */
export function toHexColor(value: string, fallback = '#000000'): string {
  const input = value.trim().toLowerCase();

  const keyword = KEYWORDS[input];
  if (keyword) return keyword;

  if (input.startsWith('#')) {
    const digits = input.slice(1);
    if (digits.length === 3 || digits.length === 4) {
      const [r, g, b] = [...digits.slice(0, 3)];
      return `#${r}${r}${g}${g}${b}${b}`;
    }
    if (digits.length === 6 || digits.length === 8) return `#${digits.slice(0, 6)}`;
    return fallback;
  }

  const rgb = /^rgba?\(([^)]+)\)$/.exec(input);
  if (rgb) {
    const parts = splitComponents(rgb[1]!);
    if (parts.length < 3) return fallback;
    return hex(channel(parts[0]!), channel(parts[1]!), channel(parts[2]!));
  }

  const hsl = /^hsla?\(([^)]+)\)$/.exec(input);
  if (hsl) {
    const parts = splitComponents(hsl[1]!);
    if (parts.length < 3) return fallback;
    return hslToHex(angle(parts[0]!), percent(parts[1]!), percent(parts[2]!));
  }

  return fallback;
}

function splitComponents(body: string): string[] {
  return body
    .split(/[,\s/]+/)
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

/** An rgb channel: 0-255, or a percentage. */
function channel(part: string): number {
  const value = part.endsWith('%')
    ? (Number.parseFloat(part) / 100) * 255
    : Number.parseFloat(part);
  return clamp(Math.round(value), 0, 255);
}

function angle(part: string): number {
  const value = Number.parseFloat(part);
  return Number.isFinite(value) ? ((value % 360) + 360) % 360 : 0;
}

function percent(part: string): number {
  const value = Number.parseFloat(part);
  return clamp(Number.isFinite(value) ? value / 100 : 0, 0, 1);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function hex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

function hslToHex(hue: number, saturation: number, lightness: number): string {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const sector = hue / 60;
  const second = chroma * (1 - Math.abs((sector % 2) - 1));
  const [r, g, b] =
    sector < 1
      ? [chroma, second, 0]
      : sector < 2
        ? [second, chroma, 0]
        : sector < 3
          ? [0, chroma, second]
          : sector < 4
            ? [0, second, chroma]
            : sector < 5
              ? [second, 0, chroma]
              : [chroma, 0, second];
  const offset = lightness - chroma / 2;
  return hex(
    Math.round((r + offset) * 255),
    Math.round((g + offset) * 255),
    Math.round((b + offset) * 255),
  );
}

/** Units CSS uses that convert to PDF points without a layout context. */
const UNIT_TO_POINTS: Record<string, number> = {
  pt: 1,
  px: 0.75,
  pc: 12,
  mm: 72 / 25.4,
  cm: 72 / 2.54,
  in: 72,
};

/**
 * Convert a CSS length to PDF points.
 *
 * `em`, `rem` and `%` are relative to a layout that does not exist here, so
 * they fall back rather than being guessed at.
 */
export function toPoints(value: string, fallback: number): number {
  const match = /^([0-9.]+)([a-z%]*)$/.exec(value.trim());
  if (!match) return fallback;
  const size = Number.parseFloat(match[1]!);
  if (!Number.isFinite(size)) return fallback;
  const unit = match[2] === '' ? 'pt' : match[2]!;
  const factor = UNIT_TO_POINTS[unit];
  return factor === undefined ? fallback : size * factor;
}

/**
 * Expand a CSS margin shorthand into PDF's `[left, top, right, bottom]`.
 *
 * CSS orders shorthand clockwise from the top; pdfmake starts at the left.
 * Getting that wrong swaps the margins on a non-square page, which is exactly
 * the kind of error nobody notices until something prints.
 */
export function toMargins(value: string, fallback: number): [number, number, number, number] {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  const points = parts.map((part) => toPoints(part, fallback));
  const [
    top = fallback,
    right = points[0] ?? fallback,
    bottom = points[0] ?? fallback,
    left = points[1] ?? points[0] ?? fallback,
  ] = points;
  return [left, top, right, bottom];
}
