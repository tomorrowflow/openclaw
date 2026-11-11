import type {
  WorkboardCard,
  WorkboardCardSession,
  WorkboardNodeWorktree,
} from "@openclaw/workboard-contract";
import { type VerificationSlot, undecidedImportedRound } from "./review-readiness.js";

type SessionRole = WorkboardCardSession["role"];
type SessionState = WorkboardCardSession["state"];

const ROLE_ORDER: Record<SessionRole, number> = {
  implementer: 0,
  grill: 1,
  verifier: 2,
  cross_verifier: 3,
  verdict: 4,
};

/**
 * The round a run that started at `at` worked on: the round after the newest
 * one published before it, as a rework round only starts from a publish.
 * Rounds published before `publishedAt` was recorded fall into the next one.
 */
function roundAt(worktree: WorkboardNodeWorktree | undefined, at: number): number {
  const published = worktree?.reviews?.findLast(
    (review) => review.publishedAt !== undefined && review.publishedAt <= at,
  );
  return published ? published.round + 1 : 0;
}

function implementerSessions(
  card: WorkboardCard,
  worktree: WorkboardNodeWorktree | undefined,
  currentRound: number,
): WorkboardCardSession[] {
  // Keyed by round and session, so a retried run updates its round's row.
  const rows = new Map<string, WorkboardCardSession>();
  for (const attempt of card.metadata?.attempts ?? []) {
    if (attempt.sessionKey) {
      const round = roundAt(worktree, attempt.startedAt);
      rows.set(`${round}\n${attempt.sessionKey}`, {
        role: "implementer",
        round,
        state: attempt.status === "running" ? "running" : "finished",
        sessionKey: attempt.sessionKey,
      });
    }
  }
  // A session linked without a recorded run, or whose runs aged out of the attempts.
  const linked = card.sessionKey ?? card.execution?.sessionKey;
  if (
    linked &&
    ![...rows.values()].some((row) => "sessionKey" in row && row.sessionKey === linked)
  ) {
    rows.set(`${currentRound}\n${linked}`, {
      role: "implementer",
      round: currentRound,
      state: card.execution?.status === "running" ? "running" : "finished",
      sessionKey: linked,
    });
  }
  return [...rows.values()];
}

function session(
  role: SessionRole,
  round: number,
  state: SessionState,
  sessionKey: string | undefined,
  blindRound: number | undefined,
): WorkboardCardSession[] {
  if (round === blindRound) {
    return [{ role, round, state, blind: true }];
  }
  return sessionKey ? [{ role, round, state, sessionKey }] : [];
}

function verifierSessions(
  worktree: WorkboardNodeWorktree,
  role: "verifier" | "cross_verifier",
  slot: VerificationSlot,
  blindRound: number | undefined,
): WorkboardCardSession[] {
  const published = (worktree.reviews ?? []).flatMap((review) =>
    session(role, review.round, "finished", review[slot]?.sessionKey, blindRound),
  );
  const current = worktree[slot];
  if (!current || published.some((row) => row.round === current.round)) {
    return published;
  }
  return [
    ...published,
    ...session(
      role,
      current.round,
      current.phase === "running" ? "running" : "finished",
      current.sessionKey,
      blindRound,
    ),
  ];
}

function verdictSessions(
  worktree: WorkboardNodeWorktree,
  currentRound: number,
  blindRound: number | undefined,
): WorkboardCardSession[] {
  const published = (worktree.reviews ?? []).flatMap((review) =>
    session("verdict", review.round, "finished", review.verdictSessionKey, blindRound),
  );
  const handoff = worktree.handoff;
  return handoff?.phase === "imported" && handoff.verdictSessionKey
    ? [
        ...published,
        ...session("verdict", currentRound, "finished", handoff.verdictSessionKey, blindRound),
      ]
    : published;
}

/**
 * Every recorded session that worked on the card, for the operator's session
 * list: the implementer runs, and a node ticket's grill, verifier,
 * cross-verifier, and verdict sessions, oldest round first. The verifier,
 * cross-verifier, and verdict of the round waiting for the operator's
 * decision are blind rows without their session key, whatever the rung, so
 * opening one cannot prime the decision.
 */
export function workboardCardSessions(card: WorkboardCard): WorkboardCardSession[] {
  const worktree = card.metadata?.automation?.target?.worktree;
  const currentRound = worktree?.rework?.round ?? 0;
  const blindRound = undecidedImportedRound(card)?.round;
  const grill = worktree?.grill;
  const sessions = [
    ...implementerSessions(card, worktree, currentRound),
    // The grill record keeps only its latest session and not the round it ran
    // in, so it lists under the current round.
    ...(grill?.sessionKey
      ? [
          {
            role: "grill" as const,
            round: currentRound,
            state: grill.status === "open" ? ("running" as const) : ("finished" as const),
            sessionKey: grill.sessionKey,
          },
        ]
      : []),
    ...(worktree
      ? [
          ...verifierSessions(worktree, "verifier", "verification", blindRound),
          ...verifierSessions(worktree, "cross_verifier", "crossVerification", blindRound),
          ...verdictSessions(worktree, currentRound, blindRound),
        ]
      : []),
  ];
  return sessions.toSorted(
    (left, right) => left.round - right.round || ROLE_ORDER[left.role] - ROLE_ORDER[right.role],
  );
}
