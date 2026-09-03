import type { ValidationIssue } from '../errors.js';
import type {
  InvoiceData,
  InvoiceType,
  LineType,
  SummaryByVatRateType,
  SummarySimplifiedType,
  SummaryType,
  VatRateType,
} from '../generated/types.js';
import { Decimal, sum, type RoundingMode } from './decimal.js';

/** Decimal places NAV's MonetaryType permits. */
const MONETARY_SCALE = 2;

export interface SummaryOptions {
  /** Decimal places for computed amounts. Defaults to 2, per MonetaryType. */
  scale?: number;
  mode?: RoundingMode;
}

/**
 * Compute the invoice summary from the lines.
 *
 * The summary is not free-form: `summaryByVatRate` must carry one entry per
 * distinct VAT rate appearing on the lines, its net and VAT amounts must be
 * the sums of the corresponding line amounts, and the invoice totals must be
 * the sums of those. NAV rejects the whole batch when they disagree, so this
 * derives them rather than trusting a caller to keep them in step.
 *
 * Lines are grouped by their entire `lineVatRate` value, not by percentage
 * alone: a 27% line and an exempt line are different rates, and so are two
 * exempt lines citing different legal grounds.
 */
export function computeInvoiceSummary(
  invoice: InvoiceType,
  options: SummaryOptions = {},
): SummaryType {
  const scale = options.scale ?? MONETARY_SCALE;
  const mode = options.mode ?? 'half-up';
  const lines = invoice.invoiceLines?.line ?? [];

  const normal = lines.filter((line) => line.lineAmountsNormal !== undefined);
  const simplified = lines.filter((line) => line.lineAmountsSimplified !== undefined);

  const summary: SummaryType = {};

  if (simplified.length > 0) {
    summary.summarySimplified = groupBy(
      simplified,
      (line) => line.lineAmountsSimplified!.lineVatRate,
    ).map(([vatRate, group]): SummarySimplifiedType => ({
      vatRate,
      vatContentGrossAmount: total(
        group.map((line) => line.lineAmountsSimplified!.lineGrossAmountSimplified),
        scale,
        mode,
      ),
      vatContentGrossAmountHUF: total(
        group.map((line) => line.lineAmountsSimplified!.lineGrossAmountSimplifiedHUF),
        scale,
        mode,
      ),
    }));
  }

  if (normal.length > 0 || simplified.length === 0) {
    const byVatRate = groupBy(normal, (line) => line.lineAmountsNormal!.lineVatRate).map(
      ([vatRate, group]): SummaryByVatRateType => ({
        vatRate,
        vatRateNetData: {
          vatRateNetAmount: total(
            group.map((line) => line.lineAmountsNormal!.lineNetAmountData.lineNetAmount),
            scale,
            mode,
          ),
          vatRateNetAmountHUF: total(
            group.map((line) => line.lineAmountsNormal!.lineNetAmountData.lineNetAmountHUF),
            scale,
            mode,
          ),
        },
        vatRateVatData: {
          vatRateVatAmount: total(
            group.map((line) => lineVatAmount(line, 'amount', scale, mode)),
            scale,
            mode,
          ),
          vatRateVatAmountHUF: total(
            group.map((line) => lineVatAmount(line, 'huf', scale, mode)),
            scale,
            mode,
          ),
        },
      }),
    );

    summary.summaryNormal = {
      summaryByVatRate: byVatRate,
      invoiceNetAmount: total(
        byVatRate.map((entry) => entry.vatRateNetData.vatRateNetAmount),
        scale,
        mode,
      ),
      invoiceNetAmountHUF: total(
        byVatRate.map((entry) => entry.vatRateNetData.vatRateNetAmountHUF),
        scale,
        mode,
      ),
      invoiceVatAmount: total(
        byVatRate.map((entry) => entry.vatRateVatData.vatRateVatAmount),
        scale,
        mode,
      ),
      invoiceVatAmountHUF: total(
        byVatRate.map((entry) => entry.vatRateVatData.vatRateVatAmountHUF),
        scale,
        mode,
      ),
    };
  }

  summary.summaryGrossData = {
    invoiceGrossAmount: grossTotal(summary, 'amount', scale, mode),
    invoiceGrossAmountHUF: grossTotal(summary, 'huf', scale, mode),
  };

  return summary;
}

/**
 * Check that an invoice's stated summary agrees with its lines.
 *
 * Returns the discrepancies rather than throwing, because a report that lists
 * every mismatch at once is far more useful than the first one NAV happens to
 * complain about.
 */
export function checkInvoiceSummary(
  invoice: InvoiceType,
  options: SummaryOptions = {},
): ValidationIssue[] {
  if (!hasAmountBearingLines(invoice)) return [];

  const issues: ValidationIssue[] = [];
  const stated = invoice.invoiceSummary;
  const expected = computeInvoiceSummary(invoice, options);

  const compare = (path: string, actual: string | undefined, wanted: string | undefined): void => {
    if (actual === undefined || wanted === undefined) return;
    if (!Decimal.from(actual).equals(Decimal.from(wanted))) {
      issues.push({
        path,
        code: 'SUMMARY_MISMATCH',
        message: `is ${actual} but the lines total ${wanted}`,
      });
    }
  };

  if (stated.summaryNormal && expected.summaryNormal) {
    const statedNormal = stated.summaryNormal;
    const expectedNormal = expected.summaryNormal;
    compare(
      'invoiceSummary.summaryNormal.invoiceNetAmount',
      statedNormal.invoiceNetAmount,
      expectedNormal.invoiceNetAmount,
    );
    compare(
      'invoiceSummary.summaryNormal.invoiceNetAmountHUF',
      statedNormal.invoiceNetAmountHUF,
      expectedNormal.invoiceNetAmountHUF,
    );
    compare(
      'invoiceSummary.summaryNormal.invoiceVatAmount',
      statedNormal.invoiceVatAmount,
      expectedNormal.invoiceVatAmount,
    );
    compare(
      'invoiceSummary.summaryNormal.invoiceVatAmountHUF',
      statedNormal.invoiceVatAmountHUF,
      expectedNormal.invoiceVatAmountHUF,
    );

    if (statedNormal.summaryByVatRate.length !== expectedNormal.summaryByVatRate.length) {
      issues.push({
        path: 'invoiceSummary.summaryNormal.summaryByVatRate',
        code: 'SUMMARY_VAT_RATE_COUNT',
        message:
          `has ${statedNormal.summaryByVatRate.length} entries but the lines use ` +
          `${expectedNormal.summaryByVatRate.length} distinct VAT rates`,
      });
    } else {
      // Order is not significant, so match entries by their VAT rate.
      for (const [index, statedEntry] of statedNormal.summaryByVatRate.entries()) {
        const key = vatRateKey(statedEntry.vatRate);
        const expectedEntry = expectedNormal.summaryByVatRate.find(
          (candidate) => vatRateKey(candidate.vatRate) === key,
        );
        const path = `invoiceSummary.summaryNormal.summaryByVatRate.${index}`;
        if (!expectedEntry) {
          issues.push({
            path,
            code: 'SUMMARY_VAT_RATE_UNKNOWN',
            message: 'states a VAT rate that no line uses',
          });
          continue;
        }
        compare(
          `${path}.vatRateNetData.vatRateNetAmount`,
          statedEntry.vatRateNetData.vatRateNetAmount,
          expectedEntry.vatRateNetData.vatRateNetAmount,
        );
        compare(
          `${path}.vatRateVatData.vatRateVatAmount`,
          statedEntry.vatRateVatData.vatRateVatAmount,
          expectedEntry.vatRateVatData.vatRateVatAmount,
        );
      }
    }
  }

  if (stated.summaryGrossData && expected.summaryGrossData) {
    compare(
      'invoiceSummary.summaryGrossData.invoiceGrossAmount',
      stated.summaryGrossData.invoiceGrossAmount,
      expected.summaryGrossData.invoiceGrossAmount,
    );
    compare(
      'invoiceSummary.summaryGrossData.invoiceGrossAmountHUF',
      stated.summaryGrossData.invoiceGrossAmountHUF,
      expected.summaryGrossData.invoiceGrossAmountHUF,
    );
  }

  return issues;
}

/**
 * Check every invoice in a document, including batch modification documents.
 *
 * Paths are prefixed with the batch index so a caller can tell which invoice
 * of a multi-invoice document is out.
 */
export function checkDocumentSummaries(
  document: InvoiceData,
  options: SummaryOptions = {},
): ValidationIssue[] {
  const single = document.invoiceMain.invoice;
  if (single) return checkInvoiceSummary(single, options);

  return (document.invoiceMain.batchInvoice ?? []).flatMap((entry) =>
    checkInvoiceSummary(entry.invoice, options).map((issue) => ({
      ...issue,
      path: `batchInvoice.${entry.batchIndex}.${issue.path}`,
    })),
  );
}

function grossTotal(
  summary: SummaryType,
  which: 'amount' | 'huf',
  scale: number,
  mode: RoundingMode,
): string {
  const parts: string[] = [];
  if (summary.summaryNormal) {
    parts.push(
      which === 'amount'
        ? summary.summaryNormal.invoiceNetAmount
        : summary.summaryNormal.invoiceNetAmountHUF,
      which === 'amount'
        ? summary.summaryNormal.invoiceVatAmount
        : summary.summaryNormal.invoiceVatAmountHUF,
    );
  }
  for (const entry of summary.summarySimplified ?? []) {
    parts.push(which === 'amount' ? entry.vatContentGrossAmount : entry.vatContentGrossAmountHUF);
  }
  return total(parts, scale, mode);
}

/**
 * VAT of a line, stated or derived.
 *
 * `lineVatData` is optional in the schema, and NAV's own advance-invoice
 * samples omit it: the line states its net amount and its rate, and the VAT
 * follows from the two. Treating an absent `lineVatData` as zero would make
 * every such invoice look unbalanced.
 *
 * When the rate is not a percentage — exempt, out of scope, reverse charge —
 * there is no VAT to derive and the contribution is zero.
 */
function lineVatAmount(
  line: LineType,
  which: 'amount' | 'huf',
  scale: number,
  mode: RoundingMode,
): string {
  const amounts = line.lineAmountsNormal!;
  const stated =
    which === 'amount' ? amounts.lineVatData?.lineVatAmount : amounts.lineVatData?.lineVatAmountHUF;
  if (stated !== undefined) return stated;

  const percentage = amounts.lineVatRate.vatPercentage;
  if (percentage === undefined) return '0';

  const net =
    which === 'amount'
      ? amounts.lineNetAmountData.lineNetAmount
      : amounts.lineNetAmountData.lineNetAmountHUF;
  return Decimal.from(net).multiply(percentage).round(scale, mode).toString();
}

/**
 * Whether any line carries amounts at all.
 *
 * A line-data modification document can reference lines of the original
 * invoice without restating amounts. There is nothing to reconcile then, and
 * reporting a mismatch would be a false positive.
 */
export function hasAmountBearingLines(invoice: InvoiceType): boolean {
  return (invoice.invoiceLines?.line ?? []).some(
    (line) => line.lineAmountsNormal !== undefined || line.lineAmountsSimplified !== undefined,
  );
}

function total(values: string[], scale: number, mode: RoundingMode): string {
  return sum(values).round(scale, mode).toString();
}

function groupBy(
  lines: LineType[],
  rateOf: (line: LineType) => VatRateType,
): Array<[VatRateType, LineType[]]> {
  const groups = new Map<string, [VatRateType, LineType[]]>();
  for (const line of lines) {
    const rate = rateOf(line);
    const key = vatRateKey(rate);
    const existing = groups.get(key);
    if (existing) existing[1].push(line);
    else groups.set(key, [rate, [line]]);
  }
  return [...groups.values()];
}

/**
 * Stable identity of a VAT rate.
 *
 * Numeric rates are compared by value, so `0.27` and `0.2700` group together.
 *
 * Exemption and out-of-scope rates are identified by their `case` — the legal
 * ground code — and *not* by the accompanying `reason`, which is free text.
 * NAV's own new-means-of-transport sample makes the point: the line cites
 * case `KBAUK` with reason "Áfa tv. 89. §" while the summary cites the same
 * case with reason "Adómentes Közösségen belüli új közlekedési eszköz
 * értékesítés". Same rate, different prose. Grouping on the prose would split
 * one rate into two and report a spurious mismatch.
 */
export function vatRateKey(rate: VatRateType): string {
  const parts: string[] = [];
  for (const key of Object.keys(rate).sort()) {
    const value = (rate as Record<string, unknown>)[key];
    if (value === undefined) continue;
    if ((key === 'vatPercentage' || key === 'vatContent') && typeof value === 'string') {
      parts.push(`${key}=${Decimal.from(value).round(6).toString()}`);
    } else if (isDetailedReason(value)) {
      parts.push(`${key}=${value.case}`);
    } else {
      parts.push(`${key}=${JSON.stringify(value)}`);
    }
  }
  return parts.join('|');
}

function isDetailedReason(value: unknown): value is { case: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { case?: unknown }).case === 'string'
  );
}
