import type {
  WorkboardCard,
  WorkboardComment,
  WorkboardOperatorCard,
} from "@openclaw/workboard-contract";
import { workboardCardPullRequest, workboardCardStage } from "./card-stage.js";
import { isVerificationComment, nodeTicketTarget } from "./node-ticket.js";
import {
  currentNodeVerification,
  nodeRoundReviewTimes,
  reviewVerdictOf,
} from "./review-readiness.js";
import type { WorkboardDispatchResult } from "./store-inputs.js";

export const HIDDEN_VERDICT_NOTICE = "Verdict posted. It stays hidden until you decide this round.";
export const HIDDEN_VERIFICATION_NOTICE =
  "Verification finished. Its result stays hidden until you decide this round.";

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
 * A card as the operator sees it, with its derived `stage`, a node ticket's
 * `grill`, and its `rounds`, which hold only the session's reports and the
 * imports, never a verdict. Besides the claim token, dev's shadow verdict on an
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
  const reviewTimes = worktree ? nodeRoundReviewTimes(card, worktree) : [];
  const grill = worktree?.grill;
  const pullRequest = workboardCardPullRequest(card);
  const redacted = hidePendingVerdicts(redactClaimToken(card), card);
  return {
    ...redacted,
    ...(stage ? { stage } : {}),
    ...(rounds ? { rounds } : {}),
    ...(reviewTimes.length ? { reviewTimes } : {}),
    ...(grill
      ? {
          grill: {
            status: grill.status,
            rounds: grill.rounds,
            attachmentId: grill.attachmentId,
            ...(grill.sessionKey ? { sessionKey: grill.sessionKey } : {}),
          },
        }
      : {}),
    ...(pullRequest
      ? { pullRequestUrl: pullRequest.url, publishedRound: pullRequest.publishedRound }
      : {}),
  };
}

/**
 * Hides what could prime the operator's decision on an undecided imported
 * round: dev's shadow verdict, and at rung a the verification's verdict too:
 * every verification comment since the import, record or not (a re-run drops
 * the record before its comment is replaced), and the round's `done` record;
 * a `running` record stays, it holds a slot. A round that ran at rung b is
 * the agent's to decide, so its verification stays visible.
 */
function hidePendingVerdicts(redacted: WorkboardCard, card: WorkboardCard): WorkboardCard {
  const target = nodeTicketTarget(card);
  const worktree = target?.worktree;
  const handoff = worktree?.handoff;
  // Nobody decides a probe's round, so nothing it shows can prime a decision.
  if (!target || !worktree || handoff?.phase !== "imported" || card.metadata?.automation?.probe) {
    return redacted;
  }
  // A failed publish blocks the card in phase "imported"; the operator already decided.
  const decided =
    card.status === "done" ||
    card.events?.some((event) => event.toStatus === "done" && event.at >= handoff.importedAt);
  if (decided) {
    return redacted;
  }
  const rungA = worktree.rung !== "b";
  const hideRecord = rungA && currentNodeVerification(worktree, handoff)?.phase === "done";
  const isHidden = (comment: WorkboardComment) =>
    comment.createdAt >= handoff.importedAt &&
    (reviewVerdictOf(comment) !== undefined || (rungA && isVerificationComment(comment)));
  const comments = redacted.metadata?.comments;
  if (!hideRecord && !comments?.some(isHidden)) {
    return redacted;
  }
  const { verification: _verification, ...visible } = worktree;
  return {
    ...redacted,
    metadata: {
      ...redacted.metadata,
      ...(comments
        ? {
            comments: comments.map((comment) =>
              isHidden(comment)
                ? {
                    ...comment,
                    body: isVerificationComment(comment)
                      ? HIDDEN_VERIFICATION_NOTICE
                      : HIDDEN_VERDICT_NOTICE,
                  }
                : comment,
            ),
          }
        : {}),
      ...(hideRecord
        ? {
            automation: {
              ...redacted.metadata?.automation,
              target: { ...target, worktree: visible },
            },
          }
        : {}),
    },
  };
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
