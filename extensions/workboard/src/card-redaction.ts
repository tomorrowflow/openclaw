import type { WorkboardCard, WorkboardOperatorCard } from "@openclaw/workboard-contract";
import { workboardCardStage } from "./card-stage.js";
import { nodeTicketTarget, reviewVerdictOf } from "./node-ticket.js";
import type { WorkboardDispatchResult } from "./store-inputs.js";

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
 * A card as the operator sees it, with its derived `stage`. Besides the
 * claim token, dev's shadow verdict on an imported review round stays hidden
 * until the operator decides it by moving the card to done (accept, or
 * publish before a rework reopen), so the verdict cannot prime that decision.
 * Agent tools read the card unredacted, so `dev` still sees that it already
 * left a verdict.
 */
export function redactOperatorCard(card: WorkboardCard): WorkboardOperatorCard {
  const stage = workboardCardStage(card);
  const redacted = withoutVerdicts(redactClaimToken(card), card);
  return stage ? { ...redacted, stage } : redacted;
}

function withoutVerdicts(redacted: WorkboardCard, card: WorkboardCard): WorkboardCard {
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
  const visible = comments.filter(
    (comment) => comment.createdAt < handoff.importedAt || !reviewVerdictOf(comment),
  );
  return visible.length === comments.length
    ? redacted
    : { ...redacted, metadata: { ...redacted.metadata, comments: visible } };
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
