/**
 * Who asked for a queued start: the operator's Start, a reviewed rework or
 * answer reopen, a scheduled pass that waits on parent PRs or overlapping
 * tickets, or a run that hit its provider's usage limit. `migrated` marks a
 * request recorded before requests named their source.
 */
export const WORKBOARD_START_REQUEST_SOURCES = [
  "operator",
  "reopen",
  "merge_wait",
  "usage_limit_retry",
  "migrated",
] as const;
export type WorkboardStartRequestSource = (typeof WORKBOARD_START_REQUEST_SOURCES)[number];

/**
 * A node ticket's start that has to wait: its parents were not done, its
 * slot was full, or its node's login waits for a usage limit to reset. It is
 * the open row of the store's start request table, read onto the card; the
 * card loses it once it leaves todo or ready, is claimed, or is archived.
 * Queued tickets start oldest first as parents finish and slots free.
 * `usageLimitResetsAt` is when that limit resets; until then no node ticket
 * starts on the ticket's node.
 */
export type WorkboardStartRequest = {
  requestedAt: number;
  source: WorkboardStartRequestSource;
  usageLimitResetsAt?: number;
};
