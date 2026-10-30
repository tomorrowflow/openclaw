import {
  workboardAgentDecides,
  type WorkboardCard,
  type WorkboardNodeReviewVerdict,
  type WorkboardNodeRework,
  type WorkboardOrchestrationSettings,
  type WorkboardRung,
  type WorkboardTrustBlind,
  type WorkboardTrustCounts,
  type WorkboardTrustResult,
  type WorkboardTrustWeek,
} from "@openclaw/workboard-contract";
import { nodeTicketTarget } from "./node-ticket.js";
import { SMART_ZONE_TOKENS, workboardClassRung, workboardTaskClass } from "./store-constants.js";

const TRUST_WEEKS = 8;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
// 1970-01-01 was a Thursday; shifting by 3 days puts week boundaries on Mondays.
const MONDAY_OFFSET_MS = 3 * 24 * 60 * 60 * 1000;
const UNCLASSIFIED = "unclassified";
// The blind verdict (#49) and per-round publish times (#50) were deployed together.
const BLIND_SINCE = Date.parse("2026-10-11T13:01:00+02:00");
const RECENT_VERDICTS = 10;

type TicketFacts = {
  taskClass: string;
  createdAt: number;
  acceptedAt?: number;
  imported: boolean;
  blocks: number;
  /** Rework rounds that count as human corrections, ascending; unchanged rounds are left out. */
  reworkRounds: readonly number[];
  outsideCommits: number;
  questionRounds: number;
  operatorAnswers: number;
  attempts: number;
  /** Turn-end context of each run that recorded one, with when it ended. */
  contexts: ReadonlyArray<{ contextTokens: number; endedAt: number }>;
  reviews: readonly WorkboardNodeReviewVerdict[];
};

function weekStart(at: number): number {
  return Math.floor((at + MONDAY_OFFSET_MS) / WEEK_MS) * WEEK_MS - MONDAY_OFFSET_MS;
}

function median(values: number[]): number | undefined {
  const sorted = values.toSorted((a, b) => a - b);
  const upper = sorted[Math.floor(sorted.length / 2)];
  const lower = sorted[Math.ceil(sorted.length / 2) - 1];
  return upper === undefined || lower === undefined ? undefined : Math.round((lower + upper) / 2);
}

function ticketFacts(card: WorkboardCard): TicketFacts | undefined {
  const target = nodeTicketTarget(card);
  // A probe re-runs a past ticket to measure the harness, not the loop's work.
  if (!target || card.metadata?.automation?.probe) {
    return undefined;
  }
  const worktree = target.worktree;
  const handoff = worktree?.handoff;
  // The first publish is the acceptance; rework keeps it while the handoff restarts.
  const acceptedAt =
    worktree?.rework?.acceptedAt ??
    (handoff?.phase === "published" ? handoff.publishedAt : undefined);
  // Archive closes a ticket without a PR, or drops one whose PR never merged; an
  // accepted ticket archived after its merge keeps its history. The PR state sync
  // stops at the archive, so a merge it had not seen yet leaves the ticket out too.
  if (
    card.metadata?.archivedAt &&
    (acceptedAt === undefined ||
      handoff?.phase !== "published" ||
      handoff.pullRequest?.state !== "merged")
  ) {
    return undefined;
  }
  return {
    taskClass: workboardTaskClass(card.labels) ?? UNCLASSIFIED,
    createdAt: card.createdAt,
    ...(acceptedAt === undefined ? {} : { acceptedAt }),
    // A rework round drops the handoff until its own import, but the ticket was imported before.
    imported:
      handoff?.phase === "imported" ||
      handoff?.phase === "published" ||
      worktree?.rework !== undefined,
    blocks: (card.events ?? []).filter((event) => event.toStatus === "blocked").length,
    reworkRounds: countedReworkRounds(worktree?.rework),
    outsideCommits: worktree?.rework?.outsideCommits ?? 0,
    questionRounds: worktree?.questions?.rounds ?? 0,
    operatorAnswers: worktree?.questions?.operatorAnswers ?? 0,
    attempts: card.metadata?.attempts?.length ?? 0,
    contexts: (card.metadata?.attempts ?? []).flatMap(({ contextTokens, endedAt, startedAt }) =>
      contextTokens === undefined ? [] : [{ contextTokens, endedAt: endedAt ?? startedAt }],
    ),
    reviews: worktree?.reviews ?? [],
  };
}

/** How one node ticket fared by the trust KPIs' facts; undefined where they leave it out. */
export function workboardTicketOutcome(
  card: WorkboardCard,
): { accepted: boolean; clean: boolean; reworkRounds: number } | undefined {
  const ticket = ticketFacts(card);
  return ticket
    ? {
        accepted: ticket.acceptedAt !== undefined,
        clean: isClean(ticket),
        reworkRounds: ticket.reworkRounds.length,
      }
    : undefined;
}

// A round that only merged the base branch, or added nothing, corrected nothing.
function countedReworkRounds(rework: WorkboardNodeRework | undefined): number[] {
  const unchanged = new Set(rework?.unchangedRounds);
  return Array.from({ length: rework?.round ?? 0 }, (_, index) => index + 1).filter(
    (round) => !unchanged.has(round),
  );
}

// A person reworked a published round when the round right after it is a counted
// rework round. A later one corrects what came after, such as a commit a merge-only
// conflict round added, not this round.
function reworkedAfter(ticket: TicketFacts, review: WorkboardNodeReviewVerdict): boolean {
  return ticket.reworkRounds.includes(review.round + 1);
}

function verdictAgrees(ticket: TicketFacts, review: WorkboardNodeReviewVerdict): boolean {
  return (review.verdict === "rework") === reworkedAfter(ticket, review);
}

// An agent decides a round at the rung it ran at (b before rung c existed);
// at rung a the operator decides every one.
function roundRung(review: WorkboardNodeReviewVerdict): WorkboardRung {
  return review.decidedBy === "agent" ? (review.rung ?? "b") : "a";
}

/**
 * The ticket narrowed to published rounds `keep` selects, or undefined when
 * none is left; it counts as accepted only when its first publish is among them.
 */
function scopeRounds(
  ticket: TicketFacts,
  keep: (review: WorkboardNodeReviewVerdict, publishedAt: number) => boolean,
): TicketFacts | undefined {
  const reviews = ticket.reviews.filter(
    (review) => review.publishedAt !== undefined && keep(review, review.publishedAt),
  );
  if (reviews.length === 0) {
    return undefined;
  }
  const { acceptedAt, ...rest } = ticket;
  const acceptedHere = acceptedAt !== undefined && reviews.some((review) => review.round === 0);
  return { ...rest, ...(acceptedHere ? { acceptedAt } : {}), reviews };
}

function countBlind(tickets: readonly TicketFacts[]): WorkboardTrustBlind {
  const blind: WorkboardTrustBlind = {};
  for (const rung of ["a", "b", "c"] as const) {
    const scoped = tickets.flatMap(
      (ticket) =>
        scopeRounds(
          ticket,
          (review, publishedAt) => publishedAt >= BLIND_SINCE && roundRung(review) === rung,
        ) ?? [],
    );
    if (scoped.length > 0) {
      blind[rung] = countTickets(scoped);
    }
  }
  return blind;
}

function isClean(ticket: TicketFacts): boolean {
  // A question an agent answered is not a human touch; one an operator answered is.
  return (
    ticket.reworkRounds.length === 0 && ticket.outsideCommits === 0 && ticket.operatorAnswers === 0
  );
}

// An agent's own accept at rung b; a later rework round means a person disagreed.
function isAgentAccept(review: WorkboardNodeReviewVerdict): boolean {
  return review.decidedBy === "agent" && review.verdict === "accept";
}

// A person decided the round without the verification in view: the operator on
// a rung a round (a rung b round shows it), or the reader of a sampled agent accept.
function decidedBlindToVerification(review: WorkboardNodeReviewVerdict): boolean {
  return (
    (review.decidedBy === undefined && !workboardAgentDecides(review.rung)) ||
    (isAgentAccept(review) && review.sampled === true)
  );
}

// A verification agrees when `pass` met no rework of its round; `fail` and `error` count as not pass.
function verificationAgrees(ticket: TicketFacts, review: WorkboardNodeReviewVerdict): boolean {
  return (review.verification?.verdict !== "pass") === reworkedAfter(ticket, review);
}

function countTickets(tickets: readonly TicketFacts[]): WorkboardTrustCounts {
  const counts: WorkboardTrustCounts = {
    tickets: tickets.length,
    accepted: 0,
    cleanAccepted: 0,
    firstPass: 0,
    blocked: 0,
    reworkRounds: 0,
    outsideCommits: 0,
    questionRounds: 0,
    operatorAnswers: 0,
    attempts: 0,
    verdictRounds: 0,
    verdictAgreedRounds: 0,
    verdictCards: 0,
    verdictAgreedCards: 0,
    verdictMissed: 0,
    verdictMissedRecent: 0,
    agentAccepts: 0,
    reworkedAccepts: 0,
    sampledRounds: 0,
    sampledAgreed: 0,
    contextMeasured: 0,
    smartZoneBreaches: 0,
    verifiedRounds: 0,
    verifierFailed: 0,
    verifierScoredRounds: 0,
    verifierAgreedRounds: 0,
    verifierEscapes: 0,
    verifierCatches: 0,
    visualRounds: 0,
    visualAgreedRounds: 0,
  };
  for (const ticket of tickets) {
    const visual = ticket.reviews.flatMap((review) =>
      review.verification?.visual && review.verification.visual.verifier !== "not_checked"
        ? [review.verification.visual]
        : [],
    );
    counts.visualRounds += visual.length;
    counts.visualAgreedRounds += visual.filter((entry) => entry.verifier === entry.operator).length;
    const verified = ticket.reviews.filter((review) => review.verification !== undefined);
    // An agent's rework after a failed verification agrees with itself; only a
    // person's decision made without the verification in view scores it.
    const scored = verified.filter(decidedBlindToVerification);
    counts.verifiedRounds += verified.length;
    counts.verifierFailed += verified.filter(
      (review) => review.verification?.verdict === "fail",
    ).length;
    counts.verifierScoredRounds += scored.length;
    counts.verifierAgreedRounds += scored.filter((review) =>
      verificationAgrees(ticket, review),
    ).length;
    counts.verifierEscapes += scored.filter(
      (review) => review.verification?.verdict === "pass" && !verificationAgrees(ticket, review),
    ).length;
    counts.verifierCatches += scored.filter(
      (review) => review.verification?.verdict !== "pass" && verificationAgrees(ticket, review),
    ).length;
    // Shadow agreement scores the operator's decisions only; an agent's own accept agrees with itself.
    const shadow = ticket.reviews.filter((review) => review.decidedBy === undefined);
    const rounds = shadow.filter((review) => review.verdict !== "missed");
    const agreed = rounds.filter((review) => verdictAgrees(ticket, review)).length;
    const missed = shadow.length - rounds.length;
    const accepts = ticket.reviews.filter(isAgentAccept);
    const sampled = accepts.filter((review) => review.sampled === true);
    counts.agentAccepts += accepts.length;
    counts.reworkedAccepts += accepts.filter((review) => !verdictAgrees(ticket, review)).length;
    counts.sampledRounds += sampled.length;
    counts.sampledAgreed += sampled.filter((review) => verdictAgrees(ticket, review)).length;
    counts.verdictRounds += rounds.length;
    counts.verdictAgreedRounds += agreed;
    counts.verdictMissed += missed;
    // A ticket with a missed round cannot show that every round agreed.
    if (rounds.length > 0 && missed === 0) {
      counts.verdictCards += 1;
      counts.verdictAgreedCards += agreed === rounds.length ? 1 : 0;
    }
    const accepted = ticket.acceptedAt !== undefined;
    counts.accepted += accepted ? 1 : 0;
    counts.cleanAccepted += accepted && isClean(ticket) ? 1 : 0;
    counts.firstPass += ticket.imported && ticket.blocks === 0 ? 1 : 0;
    counts.blocked += ticket.blocks > 0 ? 1 : 0;
    counts.reworkRounds += ticket.reworkRounds.length;
    counts.outsideCommits += ticket.outsideCommits;
    counts.questionRounds += ticket.questionRounds;
    counts.operatorAnswers += ticket.operatorAnswers;
    counts.attempts += ticket.attempts;
    counts.contextMeasured += ticket.contexts.length;
    counts.smartZoneBreaches += ticket.contexts.filter(
      (context) => context.contextTokens > SMART_ZONE_TOKENS,
    ).length;
  }
  // Rounds from before publish times were recorded sort as the oldest.
  counts.verdictMissedRecent = tickets
    .flatMap((ticket) => ticket.reviews.filter((review) => review.decidedBy === undefined))
    .toSorted((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0))
    .slice(0, RECENT_VERDICTS)
    .filter((review) => review.verdict === "missed").length;
  return counts;
}

function trustWeek(tickets: readonly TicketFacts[], start: number): WorkboardTrustWeek {
  const accepted = tickets.flatMap((ticket) =>
    ticket.acceptedAt !== undefined && weekStart(ticket.acceptedAt) === start
      ? [{ ...ticket, leadTimeMs: ticket.acceptedAt - ticket.createdAt }]
      : [],
  );
  const leadTime = median(accepted.map((ticket) => ticket.leadTimeMs));
  const turnEndContext = median(
    tickets.flatMap((ticket) =>
      ticket.contexts.flatMap((context) =>
        weekStart(context.endedAt) === start ? [context.contextTokens] : [],
      ),
    ),
  );
  const reviewWait = median(
    tickets.flatMap((ticket) =>
      ticket.reviews.flatMap(({ importedAt, publishedAt }) =>
        importedAt !== undefined && publishedAt !== undefined && weekStart(publishedAt) === start
          ? [publishedAt - importedAt]
          : [],
      ),
    ),
  );
  return {
    weekStart: start,
    accepted: accepted.length,
    autonomous: accepted.filter((ticket) => isClean(ticket) && ticket.blocks === 0).length,
    ...(leadTime === undefined ? {} : { medianLeadTimeMs: leadTime }),
    ...(reviewWait === undefined ? {} : { medianReviewWaitMs: reviewWait }),
    ...(turnEndContext === undefined ? {} : { medianContextTokens: turnEndContext }),
  };
}

/** The current week of the trust KPIs alone, for a projection that shows only it. */
export function projectWorkboardTrustWeek(
  cards: readonly WorkboardCard[],
  now: number,
): WorkboardTrustWeek {
  return trustWeek(
    cards.flatMap((card) => ticketFacts(card) ?? []),
    weekStart(now),
  );
}

/**
 * Projects the dev loop trust KPIs (D9/D53) from node ticket cards on read.
 * Per-class counts gate trust-ladder promotions; the weekly autonomy trend
 * (accepted with zero human touches), median lead time from create to
 * accept, and median review wait from import to publish show whether the
 * whole loop improves and how much of the lead time is the operator's.
 */
export function projectWorkboardTrust(
  cards: readonly WorkboardCard[],
  boardId: string,
  now: number,
  /** The board's class rungs; only a one-board projection passes them. */
  board?: Pick<WorkboardOrchestrationSettings, "classRungs">,
): WorkboardTrustResult {
  const tickets = cards.flatMap((card) => ticketFacts(card) ?? []);
  const byClass = new Map<string, TicketFacts[]>();
  for (const ticket of tickets) {
    byClass.set(ticket.taskClass, [...(byClass.get(ticket.taskClass) ?? []), ticket]);
  }
  const currentWeek = weekStart(now);
  const weeks = Array.from({ length: TRUST_WEEKS }, (_, index) =>
    trustWeek(tickets, currentWeek - (TRUST_WEEKS - 1 - index) * WEEK_MS),
  );
  return {
    boardId,
    generatedAt: now,
    smartZoneTokens: SMART_ZONE_TOKENS,
    total: countTickets(tickets),
    classes: [...byClass]
      .map(([taskClass, entries]) => {
        const classRung = board && workboardClassRung(board, [`class:${taskClass}`]);
        const since = classRung?.since;
        return Object.assign(
          { taskClass },
          board ? { rung: classRung?.rung ?? "a" } : {},
          countTickets(entries),
          { blind: countBlind(entries) },
          since === undefined
            ? {}
            : {
                rungSince: since,
                sinceRung: countTickets(
                  entries.flatMap(
                    (ticket) => scopeRounds(ticket, (_, publishedAt) => publishedAt >= since) ?? [],
                  ),
                ),
              },
        );
      })
      .toSorted((a, b) => a.taskClass.localeCompare(b.taskClass)),
    weeks,
  };
}
