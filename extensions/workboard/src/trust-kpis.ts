import type {
  WorkboardCard,
  WorkboardTrustCounts,
  WorkboardTrustResult,
  WorkboardTrustWeek,
} from "@openclaw/workboard-contract";
import { nodeTicketTarget } from "./node-ticket.js";

const TRUST_WEEKS = 8;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
// 1970-01-01 was a Thursday; shifting by 3 days puts week boundaries on Mondays.
const MONDAY_OFFSET_MS = 3 * 24 * 60 * 60 * 1000;
const UNCLASSIFIED = "unclassified";

type TicketFacts = {
  taskClass: string;
  createdAt: number;
  acceptedAt?: number;
  imported: boolean;
  blocks: number;
  reworkRounds: number;
  outsideCommits: number;
  attempts: number;
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
  if (!target) {
    return undefined;
  }
  const worktree = target.worktree;
  const handoff = worktree?.handoff;
  const label = card.labels.find((entry) => entry.startsWith("class:"));
  return {
    taskClass: label?.slice("class:".length).trim() || UNCLASSIFIED,
    createdAt: card.createdAt,
    // The first publish is the acceptance; rework keeps it while the handoff restarts.
    ...(worktree?.rework
      ? { acceptedAt: worktree.rework.acceptedAt }
      : handoff?.phase === "published"
        ? { acceptedAt: handoff.publishedAt }
        : {}),
    // A rework round drops the handoff until its own import, but the ticket was imported before.
    imported:
      handoff?.phase === "imported" ||
      handoff?.phase === "published" ||
      worktree?.rework !== undefined,
    blocks: (card.events ?? []).filter((event) => event.toStatus === "blocked").length,
    reworkRounds: worktree?.rework?.round ?? 0,
    outsideCommits: worktree?.rework?.outsideCommits ?? 0,
    attempts: card.metadata?.attempts?.length ?? 0,
  };
}

function isClean(ticket: TicketFacts): boolean {
  return ticket.reworkRounds === 0 && ticket.outsideCommits === 0;
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
    attempts: 0,
  };
  for (const ticket of tickets) {
    const accepted = ticket.acceptedAt !== undefined;
    counts.accepted += accepted ? 1 : 0;
    counts.cleanAccepted += accepted && isClean(ticket) ? 1 : 0;
    counts.firstPass += ticket.imported && ticket.blocks === 0 ? 1 : 0;
    counts.blocked += ticket.blocks > 0 ? 1 : 0;
    counts.reworkRounds += ticket.reworkRounds;
    counts.outsideCommits += ticket.outsideCommits;
    counts.attempts += ticket.attempts;
  }
  return counts;
}

/**
 * Projects the dev loop trust KPIs (D9/D53) from node ticket cards on read.
 * Per-class counts gate trust-ladder promotions; the weekly autonomy trend
 * (accepted with zero human touches) and median lead time from create to
 * accept show whether the whole loop improves.
 */
export function projectWorkboardTrust(
  cards: readonly WorkboardCard[],
  boardId: string,
  now: number,
): WorkboardTrustResult {
  const tickets = cards.flatMap((card) => ticketFacts(card) ?? []);
  const byClass = new Map<string, TicketFacts[]>();
  for (const ticket of tickets) {
    byClass.set(ticket.taskClass, [...(byClass.get(ticket.taskClass) ?? []), ticket]);
  }
  const currentWeek = weekStart(now);
  const weeks: WorkboardTrustWeek[] = [];
  for (let index = TRUST_WEEKS - 1; index >= 0; index -= 1) {
    const start = currentWeek - index * WEEK_MS;
    const accepted = tickets.flatMap((ticket) =>
      ticket.acceptedAt !== undefined && weekStart(ticket.acceptedAt) === start
        ? [{ ...ticket, leadTimeMs: ticket.acceptedAt - ticket.createdAt }]
        : [],
    );
    const leadTime = median(accepted.map((ticket) => ticket.leadTimeMs));
    weeks.push({
      weekStart: start,
      accepted: accepted.length,
      autonomous: accepted.filter((ticket) => isClean(ticket) && ticket.blocks === 0).length,
      ...(leadTime === undefined ? {} : { medianLeadTimeMs: leadTime }),
    });
  }
  return {
    boardId,
    generatedAt: now,
    total: countTickets(tickets),
    classes: [...byClass]
      .map(([taskClass, entries]) => Object.assign({ taskClass }, countTickets(entries)))
      .toSorted((a, b) => a.taskClass.localeCompare(b.taskClass)),
    weeks,
  };
}
