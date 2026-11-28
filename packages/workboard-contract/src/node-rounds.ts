// What a node ticket round decided, changed, and found in its worktree.

/**
 * One row of a node ticket session's decision trail: a fork chosen, a unit
 * verified, a pivot or revert, a blocker. Cells are single-line session
 * output; `evidence` points at a commit, a `file:line`, or a command.
 */
export type WorkboardNodeDecision = {
  ts?: string;
  phase: string;
  decision: string;
  why?: string;
  evidence?: string;
  result?: string;
};

/** One file an imported range changed, from `git diff --numstat`; binary files have no line counts. */
export type WorkboardNodeChangedFile = { path: string; previousPath?: string } & (
  | { added: number; deleted: number }
  | { binary: true }
);

/** What one round's import changed, `from..to`; `files` is capped, `totals` counts every file. */
export type WorkboardNodeChanges = {
  from: string;
  to: string;
  files: WorkboardNodeChangedFile[];
  totals: { files: number; added: number; deleted: number };
};

/**
 * One finding of a code round's standards self-review. `line` is 1-based in the
 * round's final commit when `fixed` is false, and in the tree the reviewer saw
 * when true. `rule` names the CODING_STANDARDS.md rule.
 */
export type WorkboardNodeFinding = {
  path: string;
  line: number;
  body: string;
  rule?: string;
  fixed: boolean;
};

/**
 * A code round's standards self-review. The counts cover every finding; `items`
 * is capped and absent when the report gave only counts.
 */
export type WorkboardNodeReview = {
  findings: number;
  fixed: number;
  note?: string;
  items?: WorkboardNodeFinding[];
};

/**
 * What one round of a node ticket decided and changed. `round` is the rework
 * round (0 for the first run); its reports append `decisions` and record
 * `review`, its import records `changes`.
 */
export type WorkboardNodeRound = {
  round: number;
  decisions?: WorkboardNodeDecision[];
  changes?: WorkboardNodeChanges;
  review?: WorkboardNodeReview;
};

/**
 * What a retried launch found in the worktree an earlier launch of the same
 * round left on the node: its HEAD, its commits since the base, and its
 * uncommitted paths. `dirtyPaths` is capped; `dirtyCount` counts them all.
 */
export type WorkboardNodeReusedWorktree = {
  headCommit: string;
  commitsSinceBase: number;
  dirtyPaths: string[];
  dirtyCount: number;
};
