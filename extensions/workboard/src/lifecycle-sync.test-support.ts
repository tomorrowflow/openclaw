import type { WorkboardExecution, WorkboardStatus } from "@openclaw/workboard-contract";
import { expect, vi } from "vitest";
import type { OpenClawPluginService } from "../api.js";
import { createWorkboardLifecycleService } from "./lifecycle-sync.js";
import type { WorkboardStore } from "./store.js";

export async function createLinkedCard(
  store: WorkboardStore,
  options: {
    status?: WorkboardStatus;
    sessionKey?: string;
    runId?: string;
    execution?: WorkboardExecution;
    agentId?: string;
    boardId?: string;
  } = {},
) {
  return await store.create({
    title: "Gateway-owned lifecycle",
    status: options.status ?? "running",
    sessionKey: options.sessionKey,
    runId: options.runId,
    execution: options.execution,
    agentId: options.agentId,
    boardId: options.boardId,
  });
}

export function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

/** Runs one lifecycle service sweep over `sessions` and waits for its admitted operation. */
export async function runSessionSweep(params: {
  store: WorkboardStore;
  sessions: Array<{
    key: string;
    updatedAt?: number;
    status?: "running" | "done" | "failed" | "killed" | "timeout";
    hasActiveRun?: boolean;
    abortedLastRun?: boolean;
  }>;
  complete?: boolean;
  now?: number;
  onMatched?: Parameters<typeof createWorkboardLifecycleService>[0]["onMatched"];
}) {
  const readSessions = vi.fn().mockResolvedValue({
    sessions: params.sessions,
    complete: params.complete ?? true,
  });
  const now = params.now;
  const service = createWorkboardLifecycleService({
    store: params.store,
    readSessions,
    ...(params.onMatched ? { onMatched: params.onMatched } : {}),
    ...(now === undefined ? {} : { now: () => now }),
  });
  const runOperation = vi.spyOn(params.store, "runOperation");
  try {
    await service.start({ logger: { warn: vi.fn() } } as never);
    service.onGatewayStart();
    // The admitted operation spans the full sweep, including SQLite worker writes.
    expect(runOperation).toHaveBeenCalled();
    await runOperation.mock.results[0]?.value;
    expect(readSessions).toHaveBeenCalledOnce();
  } finally {
    service.onGatewayStop();
    await service.stop?.({ logger: { warn: vi.fn() } } as never);
    runOperation.mockRestore();
  }
}

export type ServiceContext = Parameters<OpenClawPluginService["start"]>[0];
export type ServiceCron = NonNullable<ReturnType<NonNullable<ServiceContext["getCron"]>>>;

export function nudgeContext(
  enqueueRun: NonNullable<ServiceCron["enqueueRun"]>,
  logger: ServiceContext["logger"] = { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
): ServiceContext {
  const unused = () => {
    throw new Error("Unexpected scheduler mutation");
  };
  return {
    config: {},
    stateDir: "unused",
    logger,
    getCron: () => ({
      enqueueRun,
      list: unused,
      add: unused,
      update: unused,
      remove: unused,
      removeStaleJobFamily: unused,
    }),
  };
}

/** Ends the nudge cooldown and lets its re-run's board lookup through the store worker. */
export async function advanceNudgeCooldown(store: WorkboardStore) {
  await vi.advanceTimersByTimeAsync(60_000);
  await store.listBoards();
  await vi.advanceTimersByTimeAsync(0);
}
