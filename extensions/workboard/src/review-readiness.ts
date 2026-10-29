import type {
  WorkboardCard,
  WorkboardComment,
  WorkboardNodeHandoff,
  WorkboardNodeVerification,
  WorkboardNodeWorktree,
  WorkboardRoundReviewTimes,
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

/** When the first verdict comment between `from` and `to` arrived. */
export function firstVerdictAt(
  card: WorkboardCard,
  from: number,
  to = Number.POSITIVE_INFINITY,
): number | undefined {
  return card.metadata?.comments?.find(
    (comment) =>
      comment.createdAt >= from &&
      comment.createdAt <= to &&
      reviewVerdictOf(comment) !== undefined,
  )?.createdAt;
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
 * The finished verification an operator's visual check is recorded on: the
 * current one of an unarchived card's imported round.
 */
export function visualCheckVerification(
  card: WorkboardCard,
): Extract<WorkboardNodeVerification, { phase: "done" }> | undefined {
  const worktree = card.metadata?.automation?.target?.worktree;
  const handoff = worktree?.handoff;
  if (!worktree || handoff?.phase !== "imported" || card.metadata?.archivedAt) {
    return undefined;
  }
  const verification = currentNodeVerification(worktree, handoff);
  return verification?.phase === "done" ? verification : undefined;
}

/**
 * How long an imported round waits for its verification and verdict before
 * the operator may decide without them. The slowest observed pair took ~12 min.
 */
export const REVIEW_READINESS_DEADLINE_MS = 30 * 60_000;

/**
 * `since` is when the round entered the state: the import while it verifies,
 * the verification's end while the verdict is outstanding, and once ready the
 * later of the two, so the operator's wait starts at zero.
 */
export type NodeReviewReadiness =
  | { kind: "verifying"; since: number }
  | { kind: "reviewing"; since: number }
  | { kind: "ready"; since: number }
  | { kind: "incomplete"; since: number; missing: ReadonlyArray<"verification" | "verdict"> };

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
  const verification =
    handoff.verify === true ? currentNodeVerification(worktree, handoff) : undefined;
  const verifiedAt = verification?.phase === "done" ? verification.endedAt : undefined;
  const noVerification = handoff.verify === true && verifiedAt === undefined;
  const verdictAt = firstVerdictAt(card, handoff.importedAt);
  const noVerdict = verdictAt === undefined;
  if (!noVerification && !noVerdict) {
    return { kind: "ready", since: Math.max(handoff.importedAt, verifiedAt ?? 0, verdictAt) };
  }
  if (now - handoff.importedAt >= REVIEW_READINESS_DEADLINE_MS) {
    return {
      kind: "incomplete",
      since: handoff.importedAt,
      missing: [
        ...(noVerification ? ["verification" as const] : []),
        ...(noVerdict ? ["verdict" as const] : []),
      ],
    };
  }
  return noVerification
    ? { kind: "verifying", since: handoff.importedAt }
    : { kind: "reviewing", since: verifiedAt ?? handoff.importedAt };
}

/**
 * Each round's verification span and verdict time, oldest first: published
 * rounds from their `reviews` entry, the imported round from the live record.
 * An entry published before the times were recorded falls back to the
 * comments for its verdict and has no verification span.
 */
export function nodeRoundReviewTimes(
  card: WorkboardCard,
  worktree: WorkboardNodeWorktree,
): WorkboardRoundReviewTimes[] {
  const published = (worktree.reviews ?? []).flatMap((entry): WorkboardRoundReviewTimes[] => {
    if (entry.importedAt === undefined) {
      return [];
    }
    const { startedAt, endedAt } = entry.verification ?? {};
    const verdictAt = entry.verdictAt ?? firstVerdictAt(card, entry.importedAt, entry.publishedAt);
    return [
      {
        round: entry.round,
        importedAt: entry.importedAt,
        ...(startedAt === undefined
          ? {}
          : { verification: { startedAt, ...(endedAt === undefined ? {} : { endedAt }) } }),
        ...(verdictAt === undefined ? {} : { verdictAt }),
      },
    ];
  });
  const handoff = worktree.handoff;
  if (handoff?.phase !== "imported") {
    return published;
  }
  const verification = currentNodeVerification(worktree, handoff);
  const verdictAt = firstVerdictAt(card, handoff.importedAt);
  return [
    ...published,
    {
      round: worktree.rework?.round ?? 0,
      importedAt: handoff.importedAt,
      ...(verification
        ? {
            verification: {
              startedAt: verification.startedAt,
              ...(verification.phase === "done" ? { endedAt: verification.endedAt } : {}),
            },
          }
        : {}),
      ...(verdictAt === undefined ? {} : { verdictAt }),
    },
  ];
}
