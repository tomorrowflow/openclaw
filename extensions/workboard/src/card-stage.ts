import type {
  WorkboardCard,
  WorkboardCardStage,
  WorkboardStatus,
} from "@openclaw/workboard-contract";

function enteredAt(card: WorkboardCard, status: WorkboardStatus): number | undefined {
  return card.events?.findLast((event) => event.toStatus === status)?.at;
}

function since(at: number | undefined): { since?: number } {
  return at === undefined ? {} : { since: at };
}

function nodeClaudeTarget(card: WorkboardCard) {
  // Not nodeTicketTarget: importing node-ticket.ts would pull this module into
  // the store's import cycle.
  const target = card.metadata?.automation?.target;
  return target?.kind === "node-claude" ? target : undefined;
}

/**
 * A node ticket's draft PR, from its first publish on: the published round's
 * PR, else the PR a rework round builds on. A publish can open a new PR when
 * the old one was closed, so the published URL wins over the rework record.
 */
export function workboardCardPullRequestUrl(card: WorkboardCard): string | undefined {
  if (card.metadata?.archivedAt) {
    return undefined;
  }
  const worktree = nodeClaudeTarget(card)?.worktree;
  return worktree?.handoff?.phase === "published"
    ? worktree.handoff.pullRequestUrl
    : worktree?.rework?.pullRequestUrl;
}

/**
 * The stage an operator sees for a card, from its status, its queued start,
 * and its node ticket handoff. Pure, so list reads and the board overview
 * derive the same answer. Never reads comments, so a pending agent verdict
 * cannot surface here.
 */
export function workboardCardStage(card: WorkboardCard): WorkboardCardStage | undefined {
  if (card.metadata?.archivedAt) {
    return undefined;
  }
  const target = nodeClaudeTarget(card);
  const worktree = target?.worktree;
  const handoff = worktree?.handoff;
  const startRequest = card.metadata?.automation?.startRequest;
  if (card.status === "blocked") {
    return { kind: "blocked", ...since(enteredAt(card, "blocked")) };
  }
  if (startRequest) {
    return { kind: "queued", since: startRequest.requestedAt };
  }
  if (card.status === "running") {
    const attempts = card.metadata?.attempts ?? [];
    const current = attempts.at(-1);
    const reworkRound = worktree?.feedback?.kind === "rework" ? worktree.rework?.round : undefined;
    return {
      kind: "running",
      ...since(current?.status === "running" ? current.startedAt : enteredAt(card, "running")),
      ...(target ? { nodeId: target.nodeId } : {}),
      ...(reworkRound ? { reworkRound } : {}),
      ...(attempts.length ? { attempt: attempts.length } : {}),
    };
  }
  // Idle statuses have no stage, even when a reopened ticket keeps its handoff.
  if (card.status !== "review" && card.status !== "done") {
    return undefined;
  }
  switch (handoff?.phase) {
    case "questions":
      if (card.status === "done") {
        break;
      }
      return {
        kind: "questions",
        since: handoff.askedAt,
        ...(handoff.escalatedAt === undefined ? {} : { escalatedAt: handoff.escalatedAt }),
      };
    case "imported":
      if (card.status !== "done") {
        return { kind: "awaiting_review", since: handoff.importedAt };
      }
      break;
    case "published":
      return {
        kind: "published",
        since: handoff.publishedAt,
        pullRequestUrl: handoff.pullRequestUrl,
        reworkRound: worktree?.rework?.round ?? 0,
      };
    case "pending":
    case undefined:
      break;
  }
  return card.status === "review"
    ? { kind: "review", ...since(enteredAt(card, "review")) }
    : { kind: "done", ...since(card.completedAt ?? enteredAt(card, "done")) };
}
