import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  normalizeEvents,
  normalizeExecution,
  normalizeMetadata,
  normalizeNodeClaudeTarget,
} from "./metadata-normalization.ts";
import { normalizeNodeRounds } from "./node-rounds-normalization.ts";
import {
  isValidWorkboardBoardId,
  normalizeWorkboardSessionsBoardSpec,
  WORKBOARD_PRIORITIES,
  WORKBOARD_STATUSES,
  type WorkboardBoardSummary,
  type WorkboardCard,
  type WorkboardCardStage,
  type WorkboardPriority,
  type WorkboardStatus,
} from "./types.ts";

function normalizeCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

/**
 * The UI only needs to know a project board sends its cards to a node (trust
 * KPIs), through its default target or a label route (D67).
 */
function normalizeBoardNodeTargets(value: unknown): Pick<WorkboardBoardSummary, "orchestration"> {
  if (!isRecord(value)) {
    return {};
  }
  const defaultTarget = normalizeNodeClaudeTarget(value.defaultTarget);
  const targetRoutes = (Array.isArray(value.targetRoutes) ? value.targetRoutes : []).flatMap(
    (route) => {
      const target = isRecord(route) ? normalizeNodeClaudeTarget(route.target) : undefined;
      const labels = isRecord(route) && Array.isArray(route.labels) ? route.labels : [];
      return target
        ? [{ labels: labels.filter((label) => typeof label === "string"), target }]
        : [];
    },
  );
  return defaultTarget || targetRoutes.length
    ? {
        orchestration: {
          ...(defaultTarget ? { defaultTarget } : {}),
          ...(targetRoutes.length ? { targetRoutes } : {}),
        },
      }
    : {};
}

function normalizeBoardSummary(value: unknown): WorkboardBoardSummary | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = typeof value.id === "string" ? value.id.trim() : "";
  if (!isValidWorkboardBoardId(id)) {
    return null;
  }
  const byStatus: Partial<Record<WorkboardStatus, number>> = {};
  if (isRecord(value.byStatus)) {
    for (const status of WORKBOARD_STATUSES) {
      if (value.byStatus[status] !== undefined) {
        byStatus[status] = normalizeCount(value.byStatus[status]);
      }
    }
  }
  const automationJobId =
    typeof value.automationJobId === "string" ? value.automationJobId.trim() : "";
  return {
    id,
    ...(value.kind === "sessions"
      ? { kind: "sessions" as const, sessions: normalizeWorkboardSessionsBoardSpec(value.sessions) }
      : {}),
    total: normalizeCount(value.total),
    active: normalizeCount(value.active),
    archived: normalizeCount(value.archived),
    byStatus,
    ...(typeof value.name === "string" && value.name.trim() ? { name: value.name.trim() } : {}),
    ...(typeof value.description === "string" && value.description.trim()
      ? { description: value.description.trim() }
      : {}),
    ...(typeof value.icon === "string" && value.icon.trim() ? { icon: value.icon.trim() } : {}),
    ...(typeof value.color === "string" && value.color.trim() ? { color: value.color.trim() } : {}),
    ...(automationJobId && automationJobId.length <= 128 ? { automationJobId } : {}),
    ...normalizeBoardNodeTargets(value.orchestration),
    ...(typeof value.updatedAt === "number" ? { updatedAt: value.updatedAt } : {}),
    ...(typeof value.archivedAt === "number" ? { archivedAt: value.archivedAt } : {}),
  };
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function pullRequestState(value: unknown): {
  pullRequestState?: "open" | "draft" | "merged" | "closed";
} {
  return value === "open" || value === "draft" || value === "merged" || value === "closed"
    ? { pullRequestState: value }
    : {};
}

/** The Gateway derives the stage; the UI keeps only shapes it can render. */
function normalizeStage(value: unknown): WorkboardCardStage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const since = finiteNumber(value.since);
  const at = since === undefined ? {} : { since };
  const kind = value.kind;
  switch (kind) {
    case "queued":
    case "verifying":
    case "reviewing":
    case "awaiting_review":
      return since === undefined ? undefined : { kind, since };
    case "review_incomplete": {
      const missing = Array.isArray(value.missing)
        ? value.missing.filter((item) => item === "verification" || item === "verdict")
        : [];
      return since === undefined ? undefined : { kind, since, missing };
    }
    case "questions": {
      const escalatedAt = finiteNumber(value.escalatedAt);
      return since === undefined
        ? undefined
        : { kind, since, ...(escalatedAt === undefined ? {} : { escalatedAt }) };
    }
    case "grilling": {
      const round = finiteNumber(value.round);
      return since === undefined || round === undefined ? undefined : { kind, since, round };
    }
    case "published": {
      const reworkRound = finiteNumber(value.reworkRound);
      return since === undefined ||
        reworkRound === undefined ||
        typeof value.pullRequestUrl !== "string"
        ? undefined
        : {
            kind,
            since,
            pullRequestUrl: value.pullRequestUrl,
            reworkRound,
            ...pullRequestState(value.pullRequestState),
          };
    }
    case "running": {
      const reworkRound = finiteNumber(value.reworkRound);
      const attempt = finiteNumber(value.attempt);
      return {
        kind,
        ...at,
        ...(typeof value.nodeId === "string" ? { nodeId: value.nodeId } : {}),
        ...(reworkRound ? { reworkRound } : {}),
        ...(attempt ? { attempt } : {}),
      };
    }
    case "blocked":
    case "review":
    case "done":
      return { kind, ...at };
    default:
      return undefined;
  }
}

function normalizeGrill(value: unknown): WorkboardCard["grill"] {
  if (
    !isRecord(value) ||
    (value.status !== "open" && value.status !== "closed") ||
    typeof value.attachmentId !== "string"
  ) {
    return undefined;
  }
  const rounds = finiteNumber(value.rounds);
  return rounds === undefined
    ? undefined
    : {
        status: value.status,
        rounds,
        attachmentId: value.attachmentId,
        ...(typeof value.sessionKey === "string" && value.sessionKey
          ? { sessionKey: value.sessionKey }
          : {}),
      };
}

function normalizeCard(value: unknown): WorkboardCard | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = typeof value.id === "string" ? value.id : "";
  const title = typeof value.title === "string" ? value.title : "";
  const status = WORKBOARD_STATUSES.includes(value.status as WorkboardStatus)
    ? (value.status as WorkboardStatus)
    : "todo";
  const priority = WORKBOARD_PRIORITIES.includes(value.priority as WorkboardPriority)
    ? (value.priority as WorkboardPriority)
    : "normal";
  if (!id || !title) {
    return null;
  }
  const execution = normalizeExecution(value.execution);
  const events = normalizeEvents(value.events);
  const metadata = normalizeMetadata(value.metadata);
  const stage = normalizeStage(value.stage);
  const rounds = normalizeNodeRounds(value.rounds);
  const grill = normalizeGrill(value.grill);
  return {
    id,
    title,
    status,
    priority,
    labels: Array.isArray(value.labels)
      ? value.labels.filter((label): label is string => typeof label === "string")
      : [],
    position: typeof value.position === "number" ? value.position : 0,
    createdAt: typeof value.createdAt === "number" ? value.createdAt : 0,
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : 0,
    ...(typeof value.notes === "string" ? { notes: value.notes } : {}),
    ...(typeof value.agentId === "string" ? { agentId: value.agentId } : {}),
    ...(typeof value.sessionKey === "string" ? { sessionKey: value.sessionKey } : {}),
    ...(typeof value.runId === "string" ? { runId: value.runId } : {}),
    ...(typeof value.sourceUrl === "string" ? { sourceUrl: value.sourceUrl } : {}),
    ...(execution ? { execution } : {}),
    ...(typeof value.startedAt === "number" ? { startedAt: value.startedAt } : {}),
    ...(typeof value.completedAt === "number" ? { completedAt: value.completedAt } : {}),
    ...(events.length ? { events } : {}),
    ...(metadata ? { metadata } : {}),
    ...(stage ? { stage } : {}),
    ...(rounds.length > 0 ? { rounds } : {}),
    ...(grill ? { grill } : {}),
    ...(typeof value.pullRequestUrl === "string" && value.pullRequestUrl.startsWith("https://")
      ? { pullRequestUrl: value.pullRequestUrl }
      : {}),
    ...(typeof value.publishedRound === "number" && Number.isInteger(value.publishedRound)
      ? { publishedRound: value.publishedRound }
      : {}),
  };
}

export function normalizeCardsPayload(payload: unknown): {
  cards: WorkboardCard[];
  boards: WorkboardBoardSummary[];
  statuses: readonly WorkboardStatus[];
} {
  if (!isRecord(payload)) {
    return { cards: [], boards: [], statuses: WORKBOARD_STATUSES };
  }
  const cards = Array.isArray(payload.cards)
    ? payload.cards.map(normalizeCard).filter((card): card is WorkboardCard => card !== null)
    : [];
  const statuses = Array.isArray(payload.statuses)
    ? payload.statuses.filter((status): status is WorkboardStatus =>
        WORKBOARD_STATUSES.includes(status as WorkboardStatus),
      )
    : WORKBOARD_STATUSES;
  const boards = Array.isArray(payload.boards)
    ? payload.boards
        .map(normalizeBoardSummary)
        .filter((board): board is WorkboardBoardSummary => board !== null)
    : [];
  return { cards, boards, statuses: statuses.length ? statuses : WORKBOARD_STATUSES };
}

export function normalizeCardPayload(payload: unknown): WorkboardCard {
  const card = isRecord(payload) ? normalizeCard(payload.card) : null;
  if (!card) {
    throw new Error("workboard response did not include a card");
  }
  return card;
}
