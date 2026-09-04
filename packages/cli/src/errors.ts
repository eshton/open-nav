/**
 * Exit codes, so a caller — a shell script or an agent — can branch on the
 * outcome without parsing the output.
 */
export const EXIT = {
  ok: 0,
  /** Something went wrong that the tool did not anticipate. */
  failure: 1,
  /** The command line or configuration was wrong. */
  usage: 2,
  /** A document failed local validation and was not sent. */
  invalid: 3,
  /** NAV rejected the request or the invoices in it. */
  rejected: 4,
  /**
   * The work could not be completed because something it depends on was
   * unavailable: the network, a NAV verdict that has not arrived, or a
   * browser to convert a document with.
   */
  unavailable: 5,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export class UsageError extends Error {
  readonly exitCode = EXIT.usage;
}
