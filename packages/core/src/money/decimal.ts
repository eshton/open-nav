import { NavValidationError } from '../errors.js';

/**
 * How to resolve a value exactly halfway between two representable ones.
 *
 * `half-up` rounds away from zero, which is what Hungarian commercial
 * practice and NAV's examples use, and is the default everywhere here.
 */
export type RoundingMode = 'half-up' | 'half-even' | 'down' | 'up';

const DECIMAL_PATTERN = /^([+-]?)(\d+)(?:\.(\d*))?$/;

/**
 * An exact decimal, held as a scaled integer.
 *
 * The NAV schemas make binary floating point untenable: `MonetaryType`
 * allows 18 significant digits, `QuantityType` allows 22 with 10 decimal
 * places, and a VAT rate of `0.27` has no exact `double` representation.
 * Since NAV rejects a batch whose lines fail to reconcile with its summary,
 * every amount is carried through as an exact value and rounded only where
 * the rules say to round.
 */
export class Decimal {
  /** Value as an integer, scaled by 10 ** scale. */
  readonly units: bigint;
  /** Number of decimal places. */
  readonly scale: number;

  private constructor(units: bigint, scale: number) {
    this.units = units;
    this.scale = scale;
  }

  static readonly ZERO = new Decimal(0n, 0);
  static readonly ONE = new Decimal(1n, 0);

  /**
   * Build a decimal from an exact representation.
   *
   * Numbers are accepted for convenience but only when they are integers or
   * survive a round trip through their shortest decimal form; anything else
   * has already lost precision and is rejected rather than silently carried
   * forward.
   */
  static from(value: Decimal | string | number | bigint): Decimal {
    if (value instanceof Decimal) return value;
    if (typeof value === 'bigint') return new Decimal(value, 0);
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        throw invalid(String(value), 'is not a finite number');
      }
      return Decimal.parse(String(value));
    }
    return Decimal.parse(value);
  }

  private static parse(text: string): Decimal {
    const match = DECIMAL_PATTERN.exec(text.trim());
    if (!match) throw invalid(text, 'is not a decimal number');
    const [, sign, whole, fraction = ''] = match;
    const units = BigInt(`${whole}${fraction}`) * (sign === '-' ? -1n : 1n);
    return new Decimal(units, fraction.length);
  }

  /** Re-express with a different number of decimal places. */
  rescale(scale: number, mode: RoundingMode = 'half-up'): Decimal {
    if (scale === this.scale) return this;
    if (scale > this.scale) {
      return new Decimal(this.units * 10n ** BigInt(scale - this.scale), scale);
    }
    const divisor = 10n ** BigInt(this.scale - scale);
    return new Decimal(divideRounded(this.units, divisor, mode), scale);
  }

  /** Round to `scale` decimal places. */
  round(scale: number, mode: RoundingMode = 'half-up'): Decimal {
    return this.rescale(scale, mode);
  }

  add(other: Decimal | string | number): Decimal {
    const [left, right, scale] = align(this, Decimal.from(other));
    return new Decimal(left + right, scale);
  }

  subtract(other: Decimal | string | number): Decimal {
    const [left, right, scale] = align(this, Decimal.from(other));
    return new Decimal(left - right, scale);
  }

  multiply(other: Decimal | string | number): Decimal {
    const right = Decimal.from(other);
    return new Decimal(this.units * right.units, this.scale + right.scale);
  }

  /**
   * Divide, rounding to `scale` decimal places.
   *
   * Division cannot be exact, so the scale is explicit rather than inferred:
   * an accidental default would be a silent precision decision.
   */
  divide(other: Decimal | string | number, scale: number, mode: RoundingMode = 'half-up'): Decimal {
    const right = Decimal.from(other);
    if (right.units === 0n) throw invalid('0', 'cannot be used as a divisor');
    // Scale the numerator so the integer division lands at the target scale.
    const shift = BigInt(scale) + BigInt(right.scale) - BigInt(this.scale);
    const numerator = shift >= 0n ? this.units * 10n ** shift : this.units;
    const denominator = shift >= 0n ? right.units : right.units * 10n ** -shift;
    return new Decimal(divideRounded(numerator, denominator, mode), scale);
  }

  negate(): Decimal {
    return new Decimal(-this.units, this.scale);
  }

  abs(): Decimal {
    return this.units < 0n ? this.negate() : this;
  }

  /** -1, 0 or 1. */
  compare(other: Decimal | string | number): -1 | 0 | 1 {
    const [left, right] = align(this, Decimal.from(other));
    return left < right ? -1 : left > right ? 1 : 0;
  }

  equals(other: Decimal | string | number): boolean {
    return this.compare(other) === 0;
  }

  isZero(): boolean {
    return this.units === 0n;
  }

  isNegative(): boolean {
    return this.units < 0n;
  }

  /** Number of significant digits, for checking `totalDigits` facets. */
  totalDigits(): number {
    const digits = (this.units < 0n ? -this.units : this.units).toString();
    return digits === '0' ? 1 : digits.length;
  }

  /** Canonical decimal text, as written into the XML. */
  toString(): string {
    const negative = this.units < 0n;
    const digits = (negative ? -this.units : this.units).toString();
    if (this.scale === 0) return `${negative ? '-' : ''}${digits}`;
    const padded = digits.padStart(this.scale + 1, '0');
    const whole = padded.slice(0, padded.length - this.scale);
    const fraction = padded.slice(padded.length - this.scale);
    return `${negative ? '-' : ''}${whole}.${fraction}`;
  }

  /** Fixed-point text with exactly `scale` decimals. */
  toFixed(scale: number, mode: RoundingMode = 'half-up'): string {
    return this.rescale(scale, mode).toString();
  }

  /** Lossy; only for display and diagnostics. */
  toNumber(): number {
    return Number(this.toString());
  }

  toJSON(): string {
    return this.toString();
  }
}

/** Sum a list exactly, with no intermediate rounding. */
export function sum(values: Array<Decimal | string | number>): Decimal {
  return values.reduce<Decimal>((total, value) => total.add(Decimal.from(value)), Decimal.ZERO);
}

function align(left: Decimal, right: Decimal): [bigint, bigint, number] {
  if (left.scale === right.scale) return [left.units, right.units, left.scale];
  const scale = Math.max(left.scale, right.scale);
  return [
    left.units * 10n ** BigInt(scale - left.scale),
    right.units * 10n ** BigInt(scale - right.scale),
    scale,
  ];
}

function divideRounded(numerator: bigint, denominator: bigint, mode: RoundingMode): bigint {
  const negative = numerator < 0n !== denominator < 0n;
  const absNumerator = numerator < 0n ? -numerator : numerator;
  const absDenominator = denominator < 0n ? -denominator : denominator;
  const quotient = absNumerator / absDenominator;
  const remainder = absNumerator % absDenominator;

  let rounded = quotient;
  if (remainder !== 0n) {
    const twice = remainder * 2n;
    switch (mode) {
      case 'down':
        break;
      case 'up':
        rounded += 1n;
        break;
      case 'half-even':
        if (twice > absDenominator || (twice === absDenominator && quotient % 2n === 1n)) {
          rounded += 1n;
        }
        break;
      default:
        // half-up: ties round away from zero.
        if (twice >= absDenominator) rounded += 1n;
    }
  }

  return negative ? -rounded : rounded;
}

function invalid(value: string, message: string): NavValidationError {
  return new NavValidationError('Invalid decimal', [
    { path: '', code: 'INVALID_DECIMAL', message: `${JSON.stringify(value)} ${message}` },
  ]);
}
