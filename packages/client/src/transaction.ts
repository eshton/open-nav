import {
  NavInvoiceRejectedError,
  NavTransportError,
  type InvoiceStatusType,
  type ProcessingResultType,
  type QueryTransactionStatusResponse,
} from '@open-nav/core';
import type { NavClient } from './client.js';

/** Statuses NAV will not move on from. */
const TERMINAL_STATUSES = new Set<InvoiceStatusType>(['DONE', 'ABORTED']);

export interface WaitForTransactionOptions {
  /** Give up after this long. Defaults to 60 000 ms. */
  timeoutMs?: number;
  /** First delay before polling, in ms. Defaults to 1 000. */
  initialDelayMs?: number;
  /** Cap on the delay between polls, in ms. Defaults to 8 000. */
  maxDelayMs?: number;
  /** Ask NAV to echo the submitted request. Defaults to false. */
  returnOriginalRequest?: boolean;
  /**
   * Throw {@link NavInvoiceRejectedError} when any invoice is ABORTED.
   * Defaults to false, so callers can inspect partial success themselves.
   */
  throwOnRejection?: boolean;
  /** Called after every poll, for progress reporting. */
  onPoll?: (results: ProcessingResultType[], attempt: number) => void;
  /** Injectable sleep, for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
}

export interface TransactionOutcome {
  transactionId: string;
  /** Per-invoice results, in batch index order. */
  results: ProcessingResultType[];
  /** Invoices NAV stored successfully. */
  accepted: ProcessingResultType[];
  /** Invoices NAV rejected outright. */
  rejected: ProcessingResultType[];
  /**
   * Invoices stored with warnings.
   *
   * A `DONE` invoice can still carry `WARN` business messages. They do not
   * block the report but usually mean something is wrong with the data, so
   * they are surfaced separately rather than folded into `accepted` silently.
   */
  warnings: ProcessingResultType[];
  /** The final status response, if any poll returned one. */
  response?: QueryTransactionStatusResponse;
}

/**
 * Poll a transaction until every invoice reaches a terminal state.
 *
 * `manageInvoice` returns a transaction id, not a verdict: NAV validates
 * asynchronously and the outcome appears later, per invoice, split across
 * technical and business validation messages. This resolves that into one
 * result.
 */
export async function waitForTransaction(
  client: NavClient,
  transactionId: string,
  options: WaitForTransactionOptions = {},
): Promise<TransactionOutcome> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const maxDelayMs = options.maxDelayMs ?? 8_000;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  let delayMs = options.initialDelayMs ?? 1_000;
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  let last: QueryTransactionStatusResponse | undefined;

  for (;;) {
    await sleep(Math.min(delayMs, Math.max(0, deadline - Date.now())));
    attempt += 1;

    const response = await client.queryTransactionStatus({
      transactionId,
      ...(options.returnOriginalRequest === undefined
        ? {}
        : { returnOriginalRequest: options.returnOriginalRequest }),
    });
    last = response;

    const results = response.processingResults?.processingResult ?? [];
    options.onPoll?.(results, attempt);

    // An empty result set means NAV has accepted the batch but not yet
    // recorded per-invoice outcomes; that is still in progress, not done.
    if (
      results.length > 0 &&
      results.every((result) => TERMINAL_STATUSES.has(result.invoiceStatus))
    ) {
      return summarise(transactionId, results, response, options);
    }

    if (Date.now() >= deadline) {
      throw new NavTransportError(
        `Transaction ${transactionId} did not reach a terminal state within ${timeoutMs}ms ` +
          `(last seen: ${describeStatuses(results)})`,
      );
    }

    delayMs = Math.min(delayMs * 2, maxDelayMs);
  }
}

function summarise(
  transactionId: string,
  results: ProcessingResultType[],
  response: QueryTransactionStatusResponse,
  options: WaitForTransactionOptions,
): TransactionOutcome {
  const ordered = [...results].sort((a, b) => a.index - b.index);
  const rejected = ordered.filter((result) => result.invoiceStatus === 'ABORTED');
  const accepted = ordered.filter((result) => result.invoiceStatus === 'DONE');
  const warnings = accepted.filter((result) =>
    (result.businessValidationMessages ?? []).some(
      (message) => message.validationResultCode === 'WARN',
    ),
  );

  if (rejected.length > 0 && options.throwOnRejection) {
    throw new NavInvoiceRejectedError(
      transactionId,
      rejected.map((result) => ({
        index: result.index,
        invoiceStatus: result.invoiceStatus,
        messages: [
          ...(result.technicalValidationMessages ?? []),
          ...(result.businessValidationMessages ?? []),
        ],
      })),
    );
  }

  return { transactionId, results: ordered, accepted, rejected, warnings, response };
}

function describeStatuses(results: ProcessingResultType[]): string {
  if (results.length === 0) return 'no per-invoice results yet';
  return results.map((result) => `#${result.index} ${result.invoiceStatus}`).join(', ');
}
