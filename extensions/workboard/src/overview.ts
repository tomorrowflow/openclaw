import type {
  WorkboardBoardSummary,
  WorkboardOperatorCard,
  WorkboardOverviewCard,
  WorkboardOverviewInFlight,
  WorkboardOverviewResult,
  WorkboardOverviewShipped,
  WorkboardOverviewWaitReason,
  WorkboardOverviewWaiting,
} from "@openclaw/workboard-contract";
import { nodeTicketTarget } from "./node-ticket.js";
import { cardBoardId } from "./store-card-helpers.js";
import { workboardClassRung } from "./store-constants.js";
import { projectWorkboardTrustWeek } from "./trust-kpis.js";

const SHIPPED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const INSIGHT_LABELS = ["gardener", "architecture"] as const;

type OverviewBoard = Pick<
  WorkboardBoardSummary,
  "id" | "automationJobId" | "orchestration" | "archivedAt"
>;

function overviewCard(card: WorkboardOperatorCard): WorkboardOverviewCard {
  const summary = card.metadata?.automation?.summary;
  return {
    cardId: card.id,
    boardId: cardBoardId(card),
    title: card.title,
    ...(summary ? { summary } : {}),
    ...(card.stage ? { stage: card.stage } : {}),
  };
}

function waiting(
  card: WorkboardOperatorCard,
  reason: WorkboardOverviewWaitReason,
  waitingSince: number | undefined,
): WorkboardOverviewWaiting {
  return {
    ...overviewCard(card),
    reason,
    ...(waitingSince === undefined ? {} : { waitingSince }),
  };
}

function inFlight(card: WorkboardOperatorCard): WorkboardOverviewInFlight {
  const target = nodeTicketTarget(card);
  const contextTokens = card.metadata?.attempts?.findLast(
    (attempt) => attempt.contextTokens !== undefined,
  )?.contextTokens;
  return {
    ...overviewCard(card),
    ...(target
      ? {
          nodeId: target.nodeId,
          round: target.worktree?.rework?.round ?? 0,
          ...(contextTokens === undefined ? {} : { contextTokens }),
        }
      : {}),
  };
}

/** A published node ticket: its PR, and who accepted the round it closed. */
function shippedTicket(
  card: WorkboardOperatorCard,
  shippedAt: number,
  pullRequestUrl: string,
): WorkboardOverviewShipped {
  const worktree = nodeTicketTarget(card)?.worktree;
  const latest = worktree?.reviews?.at(-1);
  const byAgent = latest?.decidedBy === "agent";
  return {
    ...overviewCard(card),
    shippedAt,
    pullRequestUrl,
    rounds: (worktree?.rework?.round ?? 0) + 1,
    ...(latest ? { decidedBy: byAgent ? "agent" : "operator" } : {}),
    ...(byAgent && latest.sampled !== undefined ? { sampled: latest.sampled } : {}),
    // Recorded at the publish, after the operator decided, so the verdict is no longer pending.
    ...(latest && !byAgent && latest.verdict !== "missed" ? { shadowVerdict: latest.verdict } : {}),
  };
}

/**
 * Adds one unarchived card to the bands it belongs in. Reads only the derived
 * stage and recorded handoff facts, never comments; the stage itself says
 * whether the round's verification and verdict are still pending.
 */
function place(
  result: WorkboardOverviewResult,
  card: WorkboardOperatorCard,
  board: OverviewBoard | undefined,
  now: number,
): void {
  const stage = card.stage;
  // A probe is the operator's own experiment, read through workboard.cards.probes;
  // the overview shows it only while it runs or waits on its verification.
  if (card.metadata?.automation?.probe) {
    if (
      stage?.kind === "queued" ||
      stage?.kind === "running" ||
      stage?.kind === "awaiting_review"
    ) {
      result.inFlight.push(inFlight(card));
    }
    return;
  }
  switch (stage?.kind) {
    case "blocked":
      result.needsYou.push(waiting(card, "blocked", stage.since));
      return;
    case "review":
      result.needsYou.push(waiting(card, "decide", stage.since));
      return;
    case "verifying":
    case "reviewing":
      result.inFlight.push(inFlight(card));
      return;
    case "review_incomplete":
      result.needsYou.push(waiting(card, "decide", stage.since));
      return;
    case "awaiting_review": {
      // An agent accepts only a round that ran at rung b while its class is still at rung b.
      // Only the board's automation job brings an agent to the review.
      const agentDecides =
        Boolean(board?.automationJobId) &&
        nodeTicketTarget(card)?.worktree?.rung === "b" &&
        workboardClassRung(board?.orchestration, card.labels)?.rung === "b";
      if (agentDecides) {
        result.inFlight.push(inFlight(card));
      } else {
        result.needsYou.push(waiting(card, "decide", stage.since));
      }
      return;
    }
    case "questions":
      if (stage.escalatedAt !== undefined) {
        result.needsYou.push(waiting(card, "questions", stage.escalatedAt));
      } else if (board?.automationJobId) {
        result.inFlight.push(inFlight(card));
      } else {
        // Without an automation job no agent answers, so the questions are the operator's.
        result.needsYou.push(waiting(card, "questions", stage.since));
      }
      return;
    case "grilling":
      result.needsYou.push(waiting(card, "grilling", stage.since));
      return;
    case "queued":
    case "running":
      result.inFlight.push(inFlight(card));
      return;
    case "published": {
      // An agent's rework verdict publishes a draft before it reopens the ticket.
      const latest = nodeTicketTarget(card)?.worktree?.reviews?.at(-1);
      if (latest?.decidedBy === "agent" && latest.verdict === "rework") {
        result.inFlight.push(inFlight(card));
        return;
      }
      if (now - stage.since > SHIPPED_WINDOW_MS) {
        return;
      }
      const shipped = shippedTicket(card, stage.since, stage.pullRequestUrl);
      result.shipped.push(shipped);
      // Workboard never sees the merge, so a sampled PR waits for the operator to mark it read.
      if (shipped.sampled && latest?.readAt === undefined) {
        result.needsYou.push(waiting(card, "sampled", stage.since));
      }
      return;
    }
    case "done":
      if (stage.since !== undefined && now - stage.since <= SHIPPED_WINDOW_MS) {
        result.shipped.push({ ...overviewCard(card), shippedAt: stage.since });
      }
      return;
    case undefined: {
      const label = INSIGHT_LABELS.find((entry) => card.labels.includes(entry));
      if (card.status === "backlog" && label) {
        result.insights.push({ ...overviewCard(card), label, createdAt: card.createdAt });
      }
    }
  }
}

function byTime<T>(time: (row: T) => number | undefined, direction: 1 | -1) {
  return (left: T, right: T) =>
    direction * ((time(left) ?? -Infinity) - (time(right) ?? -Infinity));
}

/**
 * Projects the Factory overview from operator-redacted cards (as
 * `workboard.cards.list` returns them, with their derived stage). Pure and
 * never stored: what waits on the operator, what is in flight, what shipped in
 * the last 7 days, and the gardener and architecture insights in the backlog.
 */
export function projectWorkboardOverview(
  cards: readonly WorkboardOperatorCard[],
  boards: readonly OverviewBoard[],
  boardId: string,
  now: number,
): WorkboardOverviewResult {
  const boardsById = new Map(boards.map((board) => [board.id, board]));
  const result: WorkboardOverviewResult = {
    boardId,
    generatedAt: now,
    needsYou: [],
    inFlight: [],
    shipped: [],
    insights: [],
    open: {},
    week: projectWorkboardTrustWeek(cards, now),
  };
  for (const card of cards) {
    const board = boardsById.get(cardBoardId(card));
    if (card.metadata?.archivedAt || board?.archivedAt) {
      continue;
    }
    if (card.status !== "done") {
      result.open[card.status] = (result.open[card.status] ?? 0) + 1;
    }
    place(result, card, board, now);
  }
  result.needsYou.sort(byTime((row) => row.waitingSince, 1));
  result.inFlight.sort(byTime((row) => row.stage?.since, 1));
  result.shipped.sort(byTime((row) => row.shippedAt, -1));
  result.insights.sort(byTime((row) => row.createdAt, -1));
  return result;
}
