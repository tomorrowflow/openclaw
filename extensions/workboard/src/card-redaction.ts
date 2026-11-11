import {
  workboardAgentDecides,
  type WorkboardAutomation,
  type WorkboardCard,
  type WorkboardComment,
  type WorkboardNodeVerification,
  type WorkboardOperatorCard,
} from "@openclaw/workboard-contract";
import { workboardCardSessions } from "./card-sessions.js";
import { workboardCardPullRequest, workboardCardStage } from "./card-stage.js";
import { blindVisualCheckComment, isVisualCheckComment } from "./node-ticket-rounds.js";
import { isVerificationComment, nodeTicketTarget } from "./node-ticket.js";
import {
  nodeRoundReviewTimes,
  reviewVerdictOf,
  undecidedImportedRound,
  visualCheckVerification,
} from "./review-readiness.js";
import type { WorkboardDispatchResult } from "./store-inputs.js";

export const HIDDEN_VERDICT_NOTICE = "Verdict posted. It stays hidden until you decide this round.";
export const HIDDEN_VERIFICATION_NOTICE =
  "Verification finished. Its result stays hidden until you decide this round.";

/**
 * A card as every agent tool and operator read returns it: the claim token
 * redacted, and the verifier's visual read left out until the operator
 * recorded their own visual check, so the read cannot prime that check.
 */
export function redactCard(card: WorkboardCard): WorkboardCard {
  const claim = card.metadata?.claim;
  const automation = withoutUncheckedVisualRead(card);
  if (!claim && !automation) {
    return card;
  }
  return {
    ...card,
    metadata: {
      ...card.metadata,
      ...(claim ? { claim: { ...claim, token: "[redacted]" } } : {}),
      ...(automation ? { automation } : {}),
    },
  };
}

function withoutUncheckedVisualRead(card: WorkboardCard): WorkboardAutomation | undefined {
  const target = nodeTicketTarget(card);
  const worktree = target?.worktree;
  const verification = worktree?.verification;
  if (
    !target ||
    !worktree ||
    verification?.phase !== "done" ||
    !verification.visual ||
    verification.visualCheck
  ) {
    return undefined;
  }
  const { visual: _hidden, ...blinded } = verification;
  return {
    ...card.metadata?.automation,
    target: { ...target, worktree: { ...worktree, verification: blinded } },
  };
}

/**
 * A card as the operator sees it, with its derived `stage`, a node ticket's
 * `grill`, and its `rounds`, which hold only the session's reports and the
 * imports, never a verdict, and the imported round's `visualCheck` once its
 * verification finished. Besides what `redactCard` leaves out, dev's shadow
 * verdict on an imported review round stays hidden
 * until the operator decides it by moving the card to done (accept, or
 * publish before a rework reopen), so the verdict cannot prime that decision.
 * The comment stays in place with its body replaced by a notice, so the
 * operator sees that a verdict exists and the card matches its event log.
 * Agent tools read the card through `redactCard` only, so `dev` still sees
 * that it already left a verdict.
 */
export function redactOperatorCard(card: WorkboardCard): WorkboardOperatorCard {
  const stage = workboardCardStage(card);
  const sessions = workboardCardSessions(card);
  const worktree = nodeTicketTarget(card)?.worktree;
  const rounds = worktree?.rounds;
  const reviewTimes = worktree ? nodeRoundReviewTimes(card, worktree) : [];
  const grill = worktree?.grill;
  const pullRequest = workboardCardPullRequest(card);
  // The operator's own check is not shadow data, so it shows even while
  // hidePendingVerdicts leaves the verification record out.
  const verification = visualCheckVerification(card);
  const preview = worktree?.preview;
  const redacted = hidePendingVerdicts(redactCard(card), card);
  return {
    ...redacted,
    ...(stage ? { stage } : {}),
    ...(sessions.length ? { sessions } : {}),
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
    ...(verification
      ? {
          visualCheck: {
            round: verification.round,
            ...(verification.visualCheck ? { check: verification.visualCheck } : {}),
          },
        }
      : {}),
    ...(preview ? { preview } : {}),
  };
}

/**
 * Hides what could prime the operator's decision on an undecided imported
 * round: dev's shadow verdict and the session that posted it, and at every
 * rung the round's verifier and cross-verifier sessions, which would show
 * the result as it forms. At rung a the verification itself stays hidden
 * too: every verification comment since the import, record or not (a re-run
 * drops the record before its comment is replaced), the verifier's part of
 * every visual check comment (the operator's verdict and note stay), and the
 * round's verification records. A round that runs at rung b or c is the
 * agent's to decide, so its finished verification results stay visible.
 */
function hidePendingVerdicts(redacted: WorkboardCard, card: WorkboardCard): WorkboardCard {
  const pending = undecidedImportedRound(card);
  // The worktree as redactCard left it, so a hidden visual read stays hidden.
  const target = nodeTicketTarget(redacted);
  const worktree = target?.worktree;
  if (!pending || !target || !worktree) {
    return redacted;
  }
  const { handoff } = pending;
  const rungA = !workboardAgentDecides(worktree.rung);
  const blindRecord = (
    record: WorkboardNodeVerification | undefined,
  ): WorkboardNodeVerification | undefined => {
    if (record?.round !== pending.round) {
      return record;
    }
    // A running record holds no result, and its session key is required.
    if (rungA || record.phase === "running") {
      return undefined;
    }
    const { sessionKey: _session, ...blind } = record;
    return blind;
  };
  const verification = blindRecord(worktree.verification);
  const crossVerification = blindRecord(worktree.crossVerification);
  const hiddenBody = (comment: WorkboardComment): string | undefined => {
    if (comment.createdAt < handoff.importedAt) {
      return undefined;
    }
    if (reviewVerdictOf(comment) !== undefined) {
      return HIDDEN_VERDICT_NOTICE;
    }
    if (!rungA) {
      return undefined;
    }
    if (isVerificationComment(comment)) {
      return HIDDEN_VERIFICATION_NOTICE;
    }
    return isVisualCheckComment(comment) ? blindVisualCheckComment(comment.body) : undefined;
  };
  const comments = redacted.metadata?.comments;
  const {
    verification: _verification,
    crossVerification: _crossVerification,
    ...withoutRecords
  } = worktree;
  const { verdictSessionKey: _verdictSession, ...blindHandoff } = handoff;
  return {
    ...redacted,
    metadata: {
      ...redacted.metadata,
      ...(comments
        ? {
            comments: comments.map((comment) => {
              const body = hiddenBody(comment);
              return body === undefined ? comment : Object.assign({}, comment, { body });
            }),
          }
        : {}),
      automation: {
        ...redacted.metadata?.automation,
        target: {
          ...target,
          worktree: {
            ...withoutRecords,
            ...(verification ? { verification } : {}),
            ...(crossVerification ? { crossVerification } : {}),
            handoff: blindHandoff,
          },
        },
      },
    },
  };
}

export function redactDispatchResult<T extends WorkboardDispatchResult>(result: T): T {
  return {
    ...result,
    promoted: result.promoted.map(redactCard),
    reclaimed: result.reclaimed.map(redactCard),
    blocked: result.blocked.map(redactCard),
    orchestrated: result.orchestrated.map(redactCard),
  };
}
