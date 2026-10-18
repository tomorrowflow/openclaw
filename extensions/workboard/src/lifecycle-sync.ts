import { AsyncResource } from "node:async_hooks";
import type { WorkboardCard } from "@openclaw/workboard-contract";
import { resolveGlobalSingleton } from "openclaw/plugin-sdk/global-singleton";
import { isIncognitoSessionKey, parseAgentSessionKey } from "openclaw/plugin-sdk/routing";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { OpenClawPluginApi, OpenClawPluginService } from "../api.js";
import { turnEndContextTokens } from "./agent-end-context.js";
import {
  cleanupWorkboardCardWorktree,
  isWorkboardWorktreeCleanupCandidate,
  type WorkboardWorktreeCleanupRuntime,
} from "./dispatcher-workspace.js";
import { takeNodeGrillChatTurn } from "./node-ticket-grill.js";
import type { WorkboardNodeTicketHandoffs } from "./node-ticket-handoff.js";
import { applyNodeTicketReport, nodeTicketIdleVerdict, nodeTicketTarget } from "./node-ticket.js";
import {
  workboardCardMatchesLifecycleLink,
  workboardCardSessionLookupKey,
  workboardCardTakesEndedRunReport,
} from "./session-link.js";
import { cardRunId, cardSessionKey } from "./store-card-helpers.js";
import { DEFAULT_WORKBOARD_DISPATCH_OWNER } from "./store-constants.js";
import type { WorkboardStore } from "./store.js";

const WORKBOARD_LIFECYCLE_SWEEP_MS = 60_000;
const WORKBOARD_STALE_SESSION_MS = 30 * 60 * 1000;
const WORKBOARD_SESSION_SWEEP_LIMIT = 10_000;
const WORKBOARD_WORKTREE_CLEANUP_SWEEP_LIMIT = 32;
// Prepared hook generations share the active service reader, never a worker's
// caller authority. Gateway restart clears both readiness and that reader.
const workboardLifecycleGatewayState = resolveGlobalSingleton<{
  ready: boolean;
  abortSignal?: AbortSignal;
  readSessions?: WorkboardLifecycleSessionReader;
}>(
  Symbol.for("openclaw.workboard.lifecycleGatewayState"),
  () => ({ ready: false }),
  (state) => {
    state.ready = false;
    state.abortSignal = undefined;
    state.readSessions = undefined;
  },
);

type WorkboardLifecycleSync = Parameters<WorkboardStore["syncLifecycle"]>[1];
type WorkboardLifecycleObservation = Partial<
  Pick<WorkboardLifecycleSync, "sourceUpdatedAt" | "stale">
> & {
  state: keyof typeof LIFECYCLE_TARGETS;
};

type WorkboardLifecycleSession = {
  key: string;
  updatedAt?: number;
  status?: "running" | "done" | "failed" | "killed" | "timeout";
  hasActiveRun?: boolean;
  abortedLastRun?: boolean;
};

type WorkboardLifecycleSessionSnapshot = {
  sessions: WorkboardLifecycleSession[];
  complete: boolean;
};

function sessionProvesPreparedAcceptance(session: WorkboardLifecycleSession): boolean {
  return (
    session.hasActiveRun === true ||
    session.status === "done" ||
    session.status === "failed" ||
    session.status === "killed" ||
    session.status === "timeout"
  );
}

type WorkboardLifecycleSessionReadOptions = {
  includeUnknown: boolean;
  sessionKey?: string;
};

type WorkboardLifecycleSessionReader = (
  options: WorkboardLifecycleSessionReadOptions,
) => Promise<WorkboardLifecycleSessionSnapshot>;

type WorkboardLifecycleMatchHandler = (input: {
  cards: readonly WorkboardCard[];
  sessionKey?: string;
}) => Promise<void>;

type WorkboardLifecycleService = OpenClawPluginService & {
  stop: () => void;
  /** Runs pending node handoffs soon, outside the caller's request authority. */
  scheduleNodeHandoffs: () => void;
  onGatewayStart: (abortSignal?: AbortSignal) => void;
  onGatewayStop: () => void;
  readSessions: WorkboardLifecycleSessionReader;
};

function needsWorkboardLifecycleReconciliation(card: WorkboardCard): boolean {
  if (card.metadata?.archivedAt) {
    return false;
  }
  // A running claim can own an accepted session even when persisting its link failed.
  // Keep those cards, and stale cleanup, in the missed-event recovery sweep.
  return Boolean(
    card.sessionKey ||
    card.runId ||
    card.execution ||
    card.status === "running" ||
    card.metadata?.claim ||
    card.metadata?.stale,
  );
}

const LIFECYCLE_TARGETS = {
  running: { targetStatus: "running", executionStatus: "running" },
  succeeded: { targetStatus: "review", executionStatus: "review" },
  failed: { targetStatus: "blocked", executionStatus: "blocked" },
  idle: { targetStatus: undefined, executionStatus: "idle" },
  stale: { targetStatus: "running", executionStatus: "running" },
} as const satisfies Record<
  string,
  Pick<WorkboardLifecycleSync, "targetStatus" | "executionStatus">
>;

async function syncWorkboardLifecycleEvent(params: {
  store: WorkboardStore;
  source: { sessionKey?: string; runId?: string };
  observation: WorkboardLifecycleObservation;
  now: number;
  onMatched?: WorkboardLifecycleMatchHandler;
}): Promise<{ cards: readonly WorkboardCard[]; count: number }> {
  const cards = (await params.store.list()).filter(
    (card) => !card.metadata?.archivedAt && workboardCardMatchesLifecycleLink(card, params.source),
  );
  const updates = Promise.all(
    cards.map(async (card) => {
      return await params.store.syncLifecycle(card.id, {
        ...LIFECYCLE_TARGETS[params.observation.state],
        sourceUpdatedAt: params.observation.sourceUpdatedAt,
        stale: params.observation.stale,
        now: params.now,
        ...(params.source.sessionKey
          ? {
              association: {
                ...(cardSessionKey(card) ? { expectedSessionKey: cardSessionKey(card) } : {}),
                ...(cardRunId(card) ? { expectedRunId: cardRunId(card) } : {}),
                sessionKey: params.source.sessionKey,
                ...(params.source.runId ? { runId: params.source.runId } : {}),
                acceptedAt: params.observation.sourceUpdatedAt ?? params.now,
              },
            }
          : {}),
      });
    }),
  );
  await Promise.all([
    updates,
    params.onMatched?.({
      cards,
      ...(params.source.sessionKey ? { sessionKey: params.source.sessionKey } : {}),
    }),
  ]);
  return { cards, count: (await updates).filter(Boolean).length };
}

export async function syncWorkboardSubagentEnded(params: {
  store: WorkboardStore;
  worktrees?: WorkboardWorktreeCleanupRuntime;
  event: {
    targetSessionKey: string;
    runId?: string;
    endedAt?: number;
    outcome?: "ok" | "error" | "timeout" | "killed" | "reset" | "deleted";
  };
  now?: number;
  onMatched?: WorkboardLifecycleMatchHandler;
}): Promise<number> {
  const now = params.now ?? Date.now();
  const synced = await syncWorkboardLifecycleEvent({
    store: params.store,
    source: { sessionKey: params.event.targetSessionKey, runId: params.event.runId },
    observation: {
      state: params.event.outcome === "ok" ? "succeeded" : "failed",
      sourceUpdatedAt: params.event.endedAt ?? now,
    },
    now,
    ...(params.onMatched ? { onMatched: params.onMatched } : {}),
  });
  if (params.worktrees) {
    for (const matched of synced.cards) {
      const card = await params.store.get(matched.id);
      if (card) {
        await cleanupWorkboardCardWorktree({
          store: params.store,
          worktrees: params.worktrees,
          card,
        });
      }
    }
  }
  return synced.count;
}

export async function syncWorkboardAgentEnded(params: {
  store: WorkboardStore;
  event: { runId?: string; success: boolean; messages?: unknown[]; durationMs?: number };
  context: { runId?: string; sessionKey?: string };
  now?: number;
  readSessions: (
    options: WorkboardLifecycleSessionReadOptions,
  ) => Promise<WorkboardLifecycleSessionSnapshot>;
  onMatched?: WorkboardLifecycleMatchHandler;
}): Promise<number> {
  const now = params.now ?? Date.now();
  const source = {
    sessionKey: params.context.sessionKey,
    runId: params.event.runId ?? params.context.runId,
  };
  // An attempt can finish before fallback settles, even with success=true.
  // Only the session owner can establish the run's terminal outcome.
  const snapshot = await params.readSessions({
    includeUnknown: params.context.sessionKey === "unknown",
    ...(params.context.sessionKey && parseAgentSessionKey(params.context.sessionKey)
      ? { sessionKey: params.context.sessionKey }
      : {}),
  });
  const session = snapshot.sessions.find((entry) => entry.key === params.context.sessionKey);
  const observation = session ? lifecycleFromSession(session, now) : undefined;
  const terminal = observation?.state === "succeeded" || observation?.state === "failed";
  // A node ticket's stalled-turn retry reports under a new run id. Only the
  // report reads it; the lifecycle writes below keep the run-id fence, so the
  // card stays linked to the round's launch run.
  const runStartedAt =
    params.event.durationMs === undefined ? undefined : now - params.event.durationMs;
  const linked = (await params.store.list()).filter(
    (card) =>
      !card.metadata?.archivedAt && workboardCardTakesEndedRunReport(card, source, runStartedAt),
  );
  // Node tickets report through their final message, not Workboard tools: a
  // block holds, and a done report leaves the card running with a pending
  // handoff that only the bundle import moves to review. The report exists
  // only in this message, so a successful attempt maps it even before the
  // session settles; a failed one waits while fallback may still continue,
  // and the sweep blocks the card if the session then stays idle.
  let nodeTicket = false;
  const reported: WorkboardCard[] = [];
  for (const card of linked) {
    const chat = { card, startedAt: runStartedAt, messages: params.event.messages ?? [] };
    if (await takeNodeGrillChatTurn(params.store, chat, terminal || params.event.success)) {
      continue;
    }
    if (card.status === "running" && nodeTicketTarget(card)) {
      nodeTicket = true;
      if (terminal || params.event.success) {
        await applyNodeTicketReport({
          store: params.store,
          card,
          messages: params.event.messages ?? [],
          success: params.event.success,
        });
        const current = await params.store.get(card.id);
        if (current && current.status !== "running") {
          reported.push(current);
        }
      }
    }
  }
  let count = 0;
  let cards: readonly WorkboardCard[] = linked;
  if (observation && terminal) {
    const synced = await syncWorkboardLifecycleEvent({
      store: params.store,
      source,
      // A node ticket's report already settled its card. Dating the observation
      // at this hook, before the report's writes, keeps it from overriding them.
      observation: nodeTicket
        ? {
            ...observation,
            state: observation.state === "succeeded" ? "idle" : observation.state,
            sourceUpdatedAt: now,
          }
        : observation,
      now,
      ...(params.onMatched ? { onMatched: params.onMatched } : {}),
    });
    count = synced.count;
    cards = synced.cards;
  } else if (reported.length > 0) {
    // The report settled its card (questions or a block) while the session was
    // still finishing, so no lifecycle write wakes the board automation.
    await params.onMatched?.({
      cards: reported,
      ...(source.sessionKey ? { sessionKey: source.sessionKey } : {}),
    });
  }
  // After any lifecycle write, which gives a session-linked attempt its run id.
  const contextTokens = turnEndContextTokens(params.event.messages ?? []);
  if (source.runId && contextTokens !== undefined) {
    for (const card of cards) {
      await params.store.recordAttemptContext(card.id, source.runId, contextTokens);
    }
  }
  return count;
}

function lifecycleFromSession(
  session: WorkboardLifecycleSession,
  now: number,
): WorkboardLifecycleObservation {
  const sourceUpdatedAt = session.updatedAt;
  if (
    session.status === "running" &&
    session.hasActiveRun === false &&
    sourceUpdatedAt !== undefined &&
    now - sourceUpdatedAt >= WORKBOARD_STALE_SESSION_MS
  ) {
    return {
      state: "stale",
      sourceUpdatedAt,
      stale: {
        detectedAt: now,
        lastSessionUpdatedAt: sourceUpdatedAt,
        reason: "Linked session has not reported recent activity.",
      },
    };
  }
  if (session.hasActiveRun === true || session.status === "running") {
    return { state: "running", sourceUpdatedAt };
  }
  if (
    session.abortedLastRun ||
    session.status === "failed" ||
    session.status === "killed" ||
    session.status === "timeout"
  ) {
    return { state: "failed", sourceUpdatedAt };
  }
  if (session.status === "done") {
    return { state: "succeeded", sourceUpdatedAt };
  }
  return { state: "idle", sourceUpdatedAt };
}

async function syncWorkboardLifecycleSessions(params: {
  store: WorkboardStore;
  cards?: readonly WorkboardCard[];
  sessions: readonly WorkboardLifecycleSession[];
  complete?: boolean;
  now?: number;
  onMatched?: WorkboardLifecycleMatchHandler;
}): Promise<number> {
  const now = params.now ?? Date.now();
  const sessionsByKey = new Map<string, WorkboardLifecycleSession>();
  const sessionsByWorkboardSuffix = new Map<string, WorkboardLifecycleSession>();
  const ambiguousWorkboardSuffixes = new Set<string>();
  for (const session of params.sessions) {
    sessionsByKey.set(session.key, session);
    const suffixIndex = session.key.lastIndexOf(":subagent:workboard-");
    if (suffixIndex >= 0) {
      const suffix = session.key.slice(suffixIndex + 1);
      const existing = sessionsByWorkboardSuffix.get(suffix);
      if (existing && existing.key !== session.key) {
        sessionsByWorkboardSuffix.delete(suffix);
        ambiguousWorkboardSuffixes.add(suffix);
      } else if (!ambiguousWorkboardSuffixes.has(suffix)) {
        sessionsByWorkboardSuffix.set(suffix, session);
      }
    }
  }
  let count = 0;
  for (const card of params.cards ?? (await params.store.list())) {
    if (card.metadata?.archivedAt) {
      continue;
    }
    const lookupKey = workboardCardSessionLookupKey(card);
    const suffixIndex = lookupKey.lastIndexOf("subagent:workboard-");
    const linkedSessionKey = cardSessionKey(card);
    const canUseAgentlessFallback =
      linkedSessionKey?.startsWith("subagent:workboard-") === true ||
      (!linkedSessionKey &&
        (!card.agentId ||
          (card.agentId === DEFAULT_WORKBOARD_DISPATCH_OWNER &&
            card.metadata?.claim?.ownerId === DEFAULT_WORKBOARD_DISPATCH_OWNER)));
    // Persisted links and explicit agent targets stay authoritative. The unique
    // suffix fallback recovers a run accepted before its link could be persisted.
    const session =
      sessionsByKey.get(lookupKey) ??
      (canUseAgentlessFallback && suffixIndex >= 0
        ? sessionsByWorkboardSuffix.get(lookupKey.slice(suffixIndex))
        : undefined);
    const launch = card.metadata?.automation?.launch;
    const preparedAcceptanceAt =
      launch?.phase === "prepared" && session && sessionProvesPreparedAcceptance(session)
        ? session.hasActiveRun === true
          ? Math.max(now, launch.preparedAt)
          : session.updatedAt
        : undefined;
    if (
      launch?.phase === "prepared" &&
      (preparedAcceptanceAt === undefined || preparedAcceptanceAt < launch.preparedAt)
    ) {
      if (
        params.complete &&
        (await params.store.failPreparedLaunch(card.id, {
          expectedLaunch: launch,
          reason: "Gateway did not accept the prepared Workboard session before restart.",
          failedAt: now,
        }))
      ) {
        count += 1;
      }
      continue;
    }
    if (!session) {
      continue;
    }
    const sessionObservation = lifecycleFromSession(session, now);
    // Only the bundle import may move a node ticket to review; a sweep that
    // missed the agent_end report leaves the card running so stale detection
    // surfaces it.
    const observation: WorkboardLifecycleObservation =
      sessionObservation.state === "succeeded" && nodeTicketTarget(card)
        ? { state: "idle", sourceUpdatedAt: sessionObservation.sourceUpdatedAt }
        : sessionObservation;
    // A second settled observation with no report and no session activity
    // since blocks the card. The block is terminal, so the card skips this
    // sweep's idle write.
    if (
      observation.state === "idle" &&
      nodeTicketIdleVerdict(card, observation.sourceUpdatedAt) !== undefined &&
      (await params.store.settleIdleNodeTicket(card.id, observation.sourceUpdatedAt))
    ) {
      count += 1;
      await params.onMatched?.({ cards: [card], sessionKey: session.key });
      continue;
    }
    if (
      await params.store.syncLifecycle(card.id, {
        ...LIFECYCLE_TARGETS[observation.state],
        sourceUpdatedAt: observation.sourceUpdatedAt,
        stale: observation.stale,
        now,
        association: {
          ...(cardSessionKey(card) ? { expectedSessionKey: cardSessionKey(card) } : {}),
          ...(cardRunId(card) ? { expectedRunId: cardRunId(card) } : {}),
          sessionKey: session.key,
          ...(preparedAcceptanceAt === undefined ? {} : { acceptedAt: preparedAcceptanceAt }),
        },
      })
    ) {
      count += 1;
      if (observation.state === "succeeded" || observation.state === "failed") {
        await params.onMatched?.({ cards: [card], sessionKey: session.key });
      }
    }
  }
  return count;
}

function normalizeSession(value: unknown): WorkboardLifecycleSession | undefined {
  if (!isRecord(value) || typeof value.key !== "string" || !value.key) {
    return undefined;
  }
  const status =
    value.status === "running" ||
    value.status === "done" ||
    value.status === "failed" ||
    value.status === "killed" ||
    value.status === "timeout"
      ? value.status
      : undefined;
  return {
    key: value.key,
    ...(typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt)
      ? { updatedAt: value.updatedAt }
      : {}),
    ...(status ? { status } : {}),
    ...(typeof value.hasActiveRun === "boolean" ? { hasActiveRun: value.hasActiveRun } : {}),
    ...(value.abortedLastRun === true ? { abortedLastRun: true } : {}),
  };
}

export async function readWorkboardLifecycleSessions(
  gateway: Pick<OpenClawPluginApi["runtime"]["gateway"], "isAvailable" | "request">,
  options: WorkboardLifecycleSessionReadOptions = { includeUnknown: false },
): Promise<WorkboardLifecycleSessionSnapshot> {
  if (!(await gateway.isAvailable())) {
    return { sessions: [], complete: false };
  }
  if (options.sessionKey) {
    const payload = await gateway.request(
      "sessions.describe",
      { key: options.sessionKey, includeDerivedTitles: false, includeLastMessage: false },
      { scopes: ["operator.read"] },
    );
    if (!isRecord(payload) || (payload.session !== null && !isRecord(payload.session))) {
      throw new Error("sessions.describe returned an invalid lifecycle snapshot");
    }
    const session = normalizeSession(payload.session);
    // An exact read establishes no facts about the rest of the catalog.
    return { sessions: session ? [session] : [], complete: false };
  }
  let includeUnknown = false;
  if (options.includeUnknown) {
    const agentsPayload = await gateway.request("agents.list", {}, { scopes: ["operator.read"] });
    if (!isRecord(agentsPayload) || typeof agentsPayload.selectionRequired !== "boolean") {
      throw new Error("agents.list returned an invalid ownership snapshot");
    }
    // The unknown key is a legacy ownerless sentinel. Preserve an existing
    // captured link only while the Gateway proves that its owner is unambiguous.
    includeUnknown = !agentsPayload.selectionRequired;
  }
  const payload = await gateway.request(
    "sessions.list",
    {
      limit: WORKBOARD_SESSION_SWEEP_LIMIT,
      configuredAgentsOnly: true,
      includeGlobal: false,
      includeUnknown,
    },
    { scopes: ["operator.read"] },
  );
  if (!isRecord(payload) || !Array.isArray(payload.sessions)) {
    throw new Error("sessions.list returned an invalid lifecycle snapshot");
  }
  return {
    sessions: payload.sessions.flatMap((value) => {
      const session = normalizeSession(value);
      return session ? [session] : [];
    }),
    // A short page proves the snapshot is complete. Keep full pages conservative
    // so absent sessions are never inferred as "missing" when the page is truncated.
    complete: payload.sessions.length < WORKBOARD_SESSION_SWEEP_LIMIT,
  };
}

export function createWorkboardLifecycleService(params: {
  store: WorkboardStore;
  worktrees?: WorkboardWorktreeCleanupRuntime;
  nodeHandoffs?: WorkboardNodeTicketHandoffs;
  readSessions: (
    options: WorkboardLifecycleSessionReadOptions,
  ) => Promise<WorkboardLifecycleSessionSnapshot>;
  now?: () => number;
  onMatched?: WorkboardLifecycleMatchHandler;
}): WorkboardLifecycleService {
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let begin: (() => void) | undefined;
  let removeDrainListener: (() => void) | undefined;
  let cleanupCursor = 0;
  let scheduleNodeHandoffs: (() => void) | undefined;
  let serviceReader: WorkboardLifecycleSessionReader | undefined;
  const cleanupWorktrees = async (
    cards: readonly WorkboardCard[],
    warn: (message: string) => void,
  ) => {
    if (!params.worktrees) {
      return;
    }
    const candidates = cards.filter(isWorkboardWorktreeCleanupCandidate);
    const start = cleanupCursor % Math.max(candidates.length, 1);
    const rotated = [...candidates.slice(start), ...candidates.slice(0, start)];
    const batch = rotated.slice(0, WORKBOARD_WORKTREE_CLEANUP_SWEEP_LIMIT);
    cleanupCursor = candidates.length === 0 ? 0 : (start + batch.length) % candidates.length;
    for (const card of batch) {
      try {
        await cleanupWorkboardCardWorktree({
          store: params.store,
          worktrees: params.worktrees,
          card,
        });
      } catch (error) {
        warn(`workboard worktree cleanup failed for card ${card.id}: ${String(error)}`);
      }
    }
  };
  let removeChangeListener: (() => void) | undefined;
  const stop = () => {
    scheduleNodeHandoffs = undefined;
    removeChangeListener?.();
    removeChangeListener = undefined;
    if (workboardLifecycleGatewayState.readSessions === serviceReader) {
      workboardLifecycleGatewayState.readSessions = undefined;
    }
    serviceReader = undefined;
    removeDrainListener?.();
    removeDrainListener = undefined;
    generation += 1;
    begin = undefined;
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  const onGatewayStop = () => {
    workboardLifecycleGatewayState.ready = false;
    workboardLifecycleGatewayState.abortSignal = undefined;
    stop();
  };
  const beginWhenGatewayReady = () => {
    if (!workboardLifecycleGatewayState.ready) {
      return;
    }
    removeDrainListener?.();
    const signal = workboardLifecycleGatewayState.abortSignal;
    if (signal?.aborted) {
      onGatewayStop();
      return;
    }
    signal?.addEventListener("abort", onGatewayStop, { once: true });
    removeDrainListener = () => signal?.removeEventListener("abort", onGatewayStop);
    begin?.();
  };
  return {
    id: "workboard-lifecycle-sync",
    async readSessions(options) {
      const reader = workboardLifecycleGatewayState.readSessions;
      if (!reader) {
        return { sessions: [], complete: false };
      }
      const snapshot = await reader(options);
      return workboardLifecycleGatewayState.readSessions === reader
        ? snapshot
        : { sessions: [], complete: false };
    },
    start(ctx) {
      const owner = ++generation;
      serviceReader = AsyncResource.bind(params.readSessions);
      workboardLifecycleGatewayState.readSessions = serviceReader;
      let begun = false;
      const { nodeHandoffs } = params;
      const scheduler = ctx.scheduler;
      // Scheduled callbacks run detached from the hook that asked for them, so
      // node requests carry the service's authority, not an ended requester's.
      scheduleNodeHandoffs =
        nodeHandoffs && scheduler
          ? () => {
              scheduler.schedule({
                id: "node-handoffs",
                delayMs: 0,
                run: () =>
                  params.store.runOperation(() =>
                    nodeHandoffs.resume((message) => ctx.logger.warn(message)),
                  ),
              });
            }
          : undefined;
      // Accepting a node ticket is a plain move to done; any card change wakes
      // the handoff owner, which finds the card and opens its draft PR.
      removeChangeListener?.();
      removeChangeListener = scheduleNodeHandoffs
        ? params.store.subscribeChanges(() => scheduleNodeHandoffs?.())
        : undefined;
      const onMatched: WorkboardLifecycleMatchHandler = async (input) => {
        if (generation === owner) {
          await params.onMatched?.(input);
        }
      };
      const reconcile = async () => {
        try {
          await params.store.runOperation(async () => {
            let cards = await params.store.list();
            if (generation !== owner) {
              return;
            }
            if (cards.some((card) => needsWorkboardLifecycleReconciliation(card))) {
              try {
                const snapshot = await params.readSessions({
                  includeUnknown: cards.some(
                    (card) => !card.metadata?.archivedAt && cardSessionKey(card) === "unknown",
                  ),
                });
                if (generation !== owner) {
                  return;
                }
                // Incognito sessions are absent from discovery. Read only identities
                // already linked to cards, without requesting private preview content.
                let describedIncognitoKeys: Set<string> | undefined;
                for (const card of cards) {
                  const sessionKey = cardSessionKey(card);
                  if (
                    card.metadata?.archivedAt ||
                    !sessionKey ||
                    !isIncognitoSessionKey(sessionKey) ||
                    describedIncognitoKeys?.has(sessionKey)
                  ) {
                    continue;
                  }
                  (describedIncognitoKeys ??= new Set()).add(sessionKey);
                  const exact = await params.readSessions({ includeUnknown: false, sessionKey });
                  if (generation !== owner) {
                    return;
                  }
                  snapshot.sessions.push(...exact.sessions);
                }
                await syncWorkboardLifecycleSessions({
                  store: params.store,
                  cards,
                  ...snapshot,
                  now: params.now?.() ?? Date.now(),
                  onMatched,
                });
                if (generation !== owner) {
                  return;
                }
                cards = await params.store.list();
              } catch (error) {
                if (generation === owner) {
                  ctx.logger.warn(`workboard lifecycle sync failed: ${String(error)}`);
                }
              }
            }
            if (generation === owner) {
              await cleanupWorktrees(cards, (message) => ctx.logger.warn(message));
            }
            if (generation === owner) {
              // Scheduled runs carry the plugin's own scope, which the draft PR
              // step's prepared token read requires.
              if (scheduleNodeHandoffs) {
                scheduleNodeHandoffs();
              } else {
                await params.nodeHandoffs?.resume((message) => ctx.logger.warn(message));
              }
            }
          });
        } catch (error) {
          if (generation === owner) {
            ctx.logger.warn(`workboard lifecycle recovery failed: ${String(error)}`);
          }
        } finally {
          if (generation === owner) {
            timer = setTimeout(() => void reconcile(), WORKBOARD_LIFECYCLE_SWEEP_MS);
            timer.unref?.();
          }
        }
      };
      begin = () => {
        if (generation !== owner || begun) {
          return;
        }
        begun = true;
        // The Gateway lifecycle signal owns the first bounded sweep; terminal
        // hooks keep end-state writes immediate between 60-second sweeps.
        void reconcile();
      };
      beginWhenGatewayReady();
    },
    stop,
    scheduleNodeHandoffs: () => scheduleNodeHandoffs?.(),
    onGatewayStart(abortSignal) {
      workboardLifecycleGatewayState.ready = true;
      workboardLifecycleGatewayState.abortSignal = abortSignal;
      beginWhenGatewayReady();
    },
    onGatewayStop,
  };
}
