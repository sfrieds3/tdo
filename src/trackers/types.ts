/** The provider seam. It grows when lifecycle sync (update/close/reopen/comment) lands; no stubs. */

/**
 * `attention`: known not to have created anything; the user must fix something (install/auth gh).
 * `retryable`: known not to have created anything; trying again later may work.
 * `uncertain`: the request may or may not have taken effect; never retried automatically.
 */
export type FailureKind = "attention" | "retryable" | "uncertain";
export type TrackerResult<T> = { ok: true; value: T } | { ok: false; kind: FailureKind; message: string };

export type NewIssue = { title: string; body: string; labels: string[] };

export interface Tracker {
  readonly provider: string;
  /** Read-only health check: tool installed, authenticated for the destination's host. */
  check(): TrackerResult<void>;
  create(issue: NewIssue): TrackerResult<{ id: string; url: string }>;
  /** Parses an issue URL into its destination and number, or undefined if it isn't one. */
  parseIssueUrl(url: string): { destination: string; id: string } | undefined;
}
