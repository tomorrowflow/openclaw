import { workboardAgentDecides } from "@openclaw/workboard-contract";
import type {
  WorkboardCard,
  WorkboardNodeWorktree,
  WorkboardOrchestrationSettings,
} from "@openclaw/workboard-contract";
import { cardInSample, COMMIT_ID, nodeTicketTarget, requireHostGit } from "./node-ticket.js";
import {
  currentNodeVerification,
  type ImportedHandoff,
  importedReworkRefusal,
  nodeReviewReadiness,
  reviewVerdictOf,
  type VerificationSlot,
} from "./review-readiness.js";
import { workboardClassRung, workboardTaskClass } from "./store-constants.js";
import type { WorkboardAgentActor } from "./store-inputs.js";

// Not in node-ticket.ts: who decides an imported round is a concern of its own.

// One in this many agent-accepted PRs is read by a person when the class sets no sampleEvery.
const DEFAULT_SAMPLE_EVERY = 3;

/**
 * Who accepts an imported node ticket on its move to done. The operator does
 * unless an agent moves it; an agent may only for a class at rung b or c on
 * the board whose round also ran at b or c, after posting its verdict, and, on
 * a board with a verifier, once the round's verification passed, plus its
 * cross-verification when the import picked the round for one. An accept
 * verdict then picks whether a person reads the PR: every reworked ticket,
 * and 1 in `sampleEvery` others, chosen by the card id so the sample is not
 * the reader's choice. Throws the refusal an agent gets.
 */
export function nodeTicketAcceptance(params: {
  card: WorkboardCard;
  worktree: WorkboardNodeWorktree;
  handoff: ImportedHandoff;
  actor?: WorkboardAgentActor;
  board?: Pick<WorkboardOrchestrationSettings, "classRungs" | "verifier" | "crossVerifier">;
}): ImportedHandoff {
  const { card, worktree, actor, board } = params;
  const { decidedBy: _decidedBy, sampled: _sampled, ...imported } = params.handoff;
  if (!actor) {
    return imported;
  }
  const classRung = workboardClassRung(board, card.labels);
  const askForVerdict = "Post `Verdict: accept` or `Verdict: rework: <finding>` as a comment";
  if (!workboardAgentDecides(classRung?.rung)) {
    throw new Error(
      `Rung a: the operator accepts ${workboardTaskClass(card.labels) ?? "unclassified"} tickets. ${askForVerdict} instead of moving the card to done.`,
    );
  }
  if (!workboardAgentDecides(worktree.rung)) {
    throw new Error(
      `This round ran before its class reached rung b, so the operator accepts it. ${askForVerdict} instead of moving the card to done.`,
    );
  }
  const verdict = (card.metadata?.comments ?? [])
    .filter((comment) => comment.createdAt >= imported.importedAt)
    .flatMap((comment) => reviewVerdictOf(comment) ?? [])
    .at(-1);
  if (!verdict) {
    throw new Error(`${askForVerdict} first, then move the card to done.`);
  }
  if (verdict === "rework") {
    return { ...imported, decidedBy: actor };
  }
  if (board?.verifier) {
    requirePassedVerification(worktree, imported, "verification");
  }
  // The import stamps crossVerify (rung c, in the cross-verifier's sample, no probe);
  // a cross-verifier removed since then gates nothing.
  if (board?.crossVerifier && imported.crossVerify) {
    requirePassedVerification(worktree, imported, "crossVerification");
  }
  const sampled =
    (worktree.rework?.round ?? 0) > 0 ||
    cardInSample(card.id, classRung.sampleEvery ?? DEFAULT_SAMPLE_EVERY);
  return { ...imported, decidedBy: actor, sampled };
}

function requirePassedVerification(
  worktree: WorkboardNodeWorktree,
  imported: ImportedHandoff,
  slot: VerificationSlot,
): void {
  const verification = currentNodeVerification(worktree, imported, slot);
  const name = slot === "crossVerification" ? "cross-verification" : "verification";
  if (verification?.phase !== "done") {
    throw new Error(`The ${name} is still running; wait for its comment.`);
  }
  if (verification.verdict === "fail") {
    throw new Error(
      `The ${name} failed: ${verification.summary || "see its comment"}. Post \`Verdict: rework: …\` and rework it.`,
    );
  }
  if (verification.verdict === "error") {
    throw new Error(
      `The ${name} could not finish (${verification.summary || "no reason recorded"}). Leave the card in review; the operator decides or re-runs it.`,
    );
  }
}

const MAX_NAMED_FLOW_REPORTS = 3;

/**
 * The `docs/flows/` files the imported round added, changed, or removed, read
 * from the host clone because the round's recorded file list is capped. A
 * round whose import recorded no commit range is not checked.
 */
async function roundFlowReports(
  hostRepoPath: string,
  worktree: WorkboardNodeWorktree,
): Promise<string[]> {
  const round = worktree.rework?.round ?? 0;
  const changes = worktree.rounds?.find((entry) => entry.round === round)?.changes;
  if (!changes) {
    return [];
  }
  if (!COMMIT_ID.test(changes.from) || !COMMIT_ID.test(changes.to)) {
    throw new Error(`round commits ${changes.from}..${changes.to} are not commit ids`);
  }
  const diff = await requireHostGit(hostRepoPath, [
    "diff",
    "--name-only",
    "--no-renames",
    "--end-of-options",
    changes.from,
    changes.to,
    "--",
    "docs/flows",
  ]);
  return diff.split("\n").filter(Boolean);
}

/**
 * An imported round's move. The move to done records who accepted it; the
 * board's rung for an agent's move is read in the queued write, so a demotion
 * applies to the next move. The operator's move to done waits for the
 * round's verification and verdict (see `nodeReviewReadiness`), as does its
 * move to todo or ready (rework), which the handoff publishes first because
 * the rework session starts from the PR branch. Agents rework via done. An
 * agent's accept of a round that changed a flow report is refused: the
 * operator decides those at every rung.
 */
export async function withImportedNodeTicketMove(params: {
  existing: WorkboardCard;
  next: WorkboardCard;
  actor?: WorkboardAgentActor;
  now: number;
  board: () => Promise<
    Pick<WorkboardOrchestrationSettings, "classRungs" | "verifier" | "crossVerifier"> | undefined
  >;
}): Promise<WorkboardCard> {
  const { existing, next, actor } = params;
  const target = nodeTicketTarget(next);
  const worktree = target?.worktree;
  if (
    !target ||
    worktree?.handoff?.phase !== "imported" ||
    existing.status === "done" ||
    next.metadata?.archivedAt
  ) {
    return next;
  }
  const rework = next.status === "todo" || next.status === "ready";
  const refusal = rework ? importedReworkRefusal(existing, next, actor !== undefined) : undefined;
  if (refusal) {
    throw new Error(refusal);
  }
  if (!rework && next.status !== "done") {
    return next;
  }
  // An agent's move passes nodeTicketAcceptance, which already demands both.
  // A probe is never reviewed, so it has no verdict to wait for.
  const readiness =
    actor || next.metadata?.automation?.probe
      ? undefined
      : nodeReviewReadiness(next, worktree, worktree.handoff, params.now);
  if (readiness?.kind === "verifying") {
    throw new Error(
      "This round's verification is still running; wait for its comment before deciding.",
    );
  }
  if (readiness?.kind === "reviewing") {
    throw new Error(
      "The board automation hasn't posted its verdict on this round yet; wait for its comment before deciding.",
    );
  }
  const handoff = nodeTicketAcceptance({
    card: next,
    worktree,
    handoff: worktree.handoff,
    actor,
    board: actor ? await params.board() : undefined,
  });
  // `sampled` marks an agent's accept; its rework verdict moves on to publish the draft PR.
  const flowReports =
    actor && handoff.sampled !== undefined
      ? await roundFlowReports(target.hostRepoPath, worktree)
      : [];
  if (flowReports.length > 0) {
    const named = flowReports.slice(0, MAX_NAMED_FLOW_REPORTS).join(", ");
    const more = flowReports.length - MAX_NAMED_FLOW_REPORTS;
    throw new Error(
      `This round changed a flow report (${named}${more > 0 ? ` and ${more} more` : ""}), so the operator decides it. Leave the card in review.`,
    );
  }
  return {
    ...next,
    metadata: {
      ...next.metadata,
      automation: {
        ...next.metadata?.automation,
        target: { ...target, worktree: { ...worktree, handoff } },
      },
    },
  };
}
