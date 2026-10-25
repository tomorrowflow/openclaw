import type {
  WorkboardCard,
  WorkboardComment,
  WorkboardNodeHandoff,
  WorkboardNodeVerification,
  WorkboardNodeWorktree,
} from "@openclaw/workboard-contract";

// Not in node-ticket.ts: card-stage.ts reads this, and importing node-ticket.ts
// would pull it into the store's import cycle.

// Agents write comments in Markdown, so the label and the value may be
// emphasized: `**Verdict:** accept`, `__Verdict: rework__: why`,
// `Verdict: **accept**`. `_` is a word character, so `\b` cannot end the value.
const REVIEW_VERDICT_PATTERN =
  /^(\*{1,2}|_{1,2})?Verdict\1?:\1?\s*(?:\*{1,2}|_{1,2})?(accept|rework)(?![a-z0-9])/i;

/** An agent's shadow verdict on a review round (`Verdict: accept|rework`), if the comment is one. */
export function reviewVerdictOf(comment: WorkboardComment): "accept" | "rework" | undefined {
  const match = comment.source?.startsWith("agent:")
    ? REVIEW_VERDICT_PATTERN.exec(comment.body.trim())?.[2]?.toLowerCase()
    : undefined;
  return match === "accept" || match === "rework" ? match : undefined;
}

export type ImportedHandoff = Extract<WorkboardNodeHandoff, { phase: "imported" }>;

/**
 * The verification of the imported round the card waits on. A record of
 * another head or round is stale: it is ignored and the next import replaces it.
 */
export function currentNodeVerification(
  worktree: WorkboardNodeWorktree,
  handoff: ImportedHandoff,
): WorkboardNodeVerification | undefined {
  const verification = worktree.verification;
  return verification &&
    verification.headCommit === handoff.headCommit &&
    verification.round === (worktree.rework?.round ?? 0)
    ? verification
    : undefined;
}

/**
 * How long an imported round waits for its verification and verdict before
 * the operator may decide without them. The slowest observed pair took ~12 min.
 */
export const REVIEW_READINESS_DEADLINE_MS = 30 * 60_000;

export type NodeReviewReadiness =
  | { kind: "verifying" }
  | { kind: "reviewing" }
  | { kind: "ready" }
  | { kind: "incomplete"; missing: ReadonlyArray<"verification" | "verdict"> };

/**
 * Whether an imported round has what its decision needs: the verification
 * when the board had a verifier at import, and the board automation's verdict
 * comment. Past the deadline a round still missing either is `incomplete`,
 * and the operator may decide it anyway. Reads comments only for whether a
 * verdict exists.
 */
export function nodeReviewReadiness(
  card: WorkboardCard,
  worktree: WorkboardNodeWorktree,
  handoff: ImportedHandoff,
  now: number,
): NodeReviewReadiness {
  const noVerification =
    handoff.verify === true && currentNodeVerification(worktree, handoff)?.phase !== "done";
  const noVerdict = !(card.metadata?.comments ?? []).some(
    (comment) => comment.createdAt >= handoff.importedAt && reviewVerdictOf(comment) !== undefined,
  );
  if (!noVerification && !noVerdict) {
    return { kind: "ready" };
  }
  if (now - handoff.importedAt >= REVIEW_READINESS_DEADLINE_MS) {
    return {
      kind: "incomplete",
      missing: [
        ...(noVerification ? ["verification" as const] : []),
        ...(noVerdict ? ["verdict" as const] : []),
      ],
    };
  }
  return { kind: noVerification ? "verifying" : "reviewing" };
}
