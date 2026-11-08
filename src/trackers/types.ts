/** Provider seam for explicit creation and one-way lifecycle delivery. */

/**
 * `attention`: the user must fix something (install/auth/permission), then explicitly retry.
 * `retryable`: an idempotent lifecycle operation (or authorized preflight) may be retried.
 * `uncertain`: a create may have taken effect; never recreate automatically.
 * Comments use retryable delivery too, with documented at-least-once semantics.
 */
export type FailureKind = "attention" | "retryable" | "uncertain";
export type TrackerResult<T> = { ok: true; value: T } | { ok: false; kind: FailureKind; message: string };

export type NewIssue = { title: string; body: string; labels: string[] };
/** Label changes ride along with an update; missing labels are created first. */
export type IssueUpdate = { title: string; body: string; addLabels?: string[]; removeLabels?: string[] };

export interface Tracker {
  readonly provider: string;
  /** Read-only health check: tool installed, authenticated for the destination's host. */
  check(): TrackerResult<void>;
  create(issue: NewIssue): TrackerResult<{ id: string; url: string }>;
  update(id: string, issue: IssueUpdate): TrackerResult<void>;
  close(id: string, reason: "completed" | "not planned"): TrackerResult<void>;
  reopen(id: string): TrackerResult<void>;
  comment(id: string, body: string): TrackerResult<void>;
  /** Parses an issue URL into its destination and number, or undefined if it isn't one. */
  parseIssueUrl(url: string): { destination: string; id: string } | undefined;
}
