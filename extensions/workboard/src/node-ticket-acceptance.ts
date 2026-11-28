import { workboardAgentDecides } from "@openclaw/workboard-contract";
import type {
  WorkboardCard,
  WorkboardNodeWorktree,
  WorkboardOrchestrationSettings,
} from "@openclaw/workboard-contract";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  cardInSample,
  COMMIT_ID,
  hostGit,
  nodeTicketBaseRef,
  nodeTicketTarget,
  requireHostGit,
} from "./node-ticket.js";
import {
  currentNodeVerification,
  type ImportedHandoff,
  importedReworkRefusal,
  nodeReviewReadiness,
  verificationNotRun,
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
  if (verification.notRun) {
    throw new Error(
      `The ${name} did not run (${verification.summary}). Leave the card in review; the operator re-runs it.`,
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
 * The `docs/flows/` files the ticket's pull request adds, changes, or removes:
 * everything on its branch since it left the default branch, so a flow report
 * from an earlier round still counts after a rework round that left it alone.
 * Read from the host clone, which needs no recorded round. Accepted edge case:
 * a branch that merged a default branch newer than the host clone's also lists
 * that merge's flow reports, a refusal the operator's accept clears.
 */
async function pullRequestFlowReports(
  hostRepoPath: string,
  baseRef: string,
  worktree: WorkboardNodeWorktree,
  headCommit: string,
): Promise<string[]> {
  if (!COMMIT_ID.test(headCommit)) {
    throw new Error(`the imported head ${headCommit} is not a commit id`);
  }
  const leftMain = await hostGit(hostRepoPath, [
    "merge-base",
    "--end-of-options",
    baseRef,
    headCommit,
  ]);
  const mergeBase = leftMain.stdout.trim();
  // Without a default-branch ref the whole ticket is checked, from the commit its branch started at.
  const from = leftMain.code === 0 && COMMIT_ID.test(mergeBase) ? mergeBase : worktree.baseCommit;
  const diff = await requireHostGit(hostRepoPath, [
    "diff",
    "--name-only",
    "--no-renames",
    "--end-of-options",
    from,
    headCommit,
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
 * agent's accept of a pull request that changes a flow report is refused: the
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
  // Accepting a round nothing verified would merge it unchecked; reworking it needs no verification.
  if (readiness && !rework && verificationNotRun(worktree, worktree.handoff)) {
    throw new Error(
      "This round's verification did not run: no verifier model could do its work. Re-run it with workboard.cards.verify once a verifier model is available, then decide.",
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
  if (actor && handoff.sampled !== undefined) {
    const flowReports = await pullRequestFlowReports(
      target.hostRepoPath,
      nodeTicketBaseRef(target),
      worktree,
      handoff.headCommit,
    ).catch((error: unknown) => {
      throw new Error(
        `Could not check this pull request for flow reports (${formatErrorMessage(error)}), so the operator decides it. Leave the card in review.`,
        { cause: error },
      );
    });
    if (flowReports.length > 0) {
      const named = flowReports.slice(0, MAX_NAMED_FLOW_REPORTS).join(", ");
      const more = flowReports.length - MAX_NAMED_FLOW_REPORTS;
      throw new Error(
        `This pull request changes a flow report (${named}${more > 0 ? ` and ${more} more` : ""}), so the operator decides it. Leave the card in review.`,
      );
    }
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
