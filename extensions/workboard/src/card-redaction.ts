import type {
  WorkboardCard,
  WorkboardComment,
  WorkboardOperatorCard,
} from "@openclaw/workboard-contract";
import { workboardCardStage } from "./card-stage.js";
import { nodeTicketTarget, reviewVerdictOf } from "./node-ticket.js";
import type { WorkboardDispatchResult } from "./store-inputs.js";

export const HIDDEN_VERDICT_NOTICE = "Verdict posted. It stays hidden until you decide this round.";

export function redactClaimToken(card: WorkboardCard): WorkboardCard {
  const claim = card.metadata?.claim;
  if (!claim) {
    return card;
  }
  return {
    ...card,
    metadata: {
      ...card.metadata,
      claim: {
        ...claim,
        token: "[redacted]",
      },
    },
  };
}

/**
 * A card as the operator sees it, with its derived `stage` and a node
 * ticket's `rounds`, which hold only the session's reports and the imports,
 * never a verdict. Besides the claim token, dev's shadow verdict on an
 * imported review round stays hidden
 * until the operator decides it by moving the card to done (accept, or
 * publish before a rework reopen), so the verdict cannot prime that decision.
 * The comment stays in place with its body replaced by a notice, so the
 * operator sees that a verdict exists and the card matches its event log.
 * Agent tools read the card unredacted, so `dev` still sees that it already
 * left a verdict.
 */
export function redactOperatorCard(card: WorkboardCard): WorkboardOperatorCard {
  const stage = workboardCardStage(card);
  const worktree = nodeTicketTarget(card)?.worktree;
  const rounds = worktree?.rounds;
  const pullRequestUrl =
    worktree?.handoff?.phase === "published"
      ? worktree.handoff.pullRequestUrl
      : worktree?.rework?.pullRequestUrl;
  const redacted = hidePendingVerdicts(redactClaimToken(card), card);
  return {
    ...redacted,
    ...(stage ? { stage } : {}),
    ...(rounds ? { rounds } : {}),
    ...(pullRequestUrl ? { pullRequestUrl } : {}),
  };
}

function hidePendingVerdicts(redacted: WorkboardCard, card: WorkboardCard): WorkboardCard {
  const handoff = nodeTicketTarget(card)?.worktree?.handoff;
  const comments = redacted.metadata?.comments;
  if (handoff?.phase !== "imported" || !comments) {
    return redacted;
  }
  // A failed publish blocks the card in phase "imported"; the operator already decided.
  const decided =
    card.status === "done" ||
    card.events?.some((event) => event.toStatus === "done" && event.at >= handoff.importedAt);
  if (decided) {
    return redacted;
  }
  if (!comments.some((comment) => isPendingVerdict(comment, handoff.importedAt))) {
    return redacted;
  }
  const shown = comments.map((comment) =>
    isPendingVerdict(comment, handoff.importedAt)
      ? { ...comment, body: HIDDEN_VERDICT_NOTICE }
      : comment,
  );
  return { ...redacted, metadata: { ...redacted.metadata, comments: shown } };
}

function isPendingVerdict(comment: WorkboardComment, importedAt: number): boolean {
  return comment.createdAt >= importedAt && reviewVerdictOf(comment) !== undefined;
}

export function redactDispatchResult<T extends WorkboardDispatchResult>(result: T): T {
  return {
    ...result,
    promoted: result.promoted.map(redactClaimToken),
    reclaimed: result.reclaimed.map(redactClaimToken),
    blocked: result.blocked.map(redactClaimToken),
    orchestrated: result.orchestrated.map(redactClaimToken),
  };
}
