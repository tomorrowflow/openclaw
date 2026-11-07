import type {
  WorkboardBoardSummary,
  WorkboardHealthAccount,
  WorkboardHealthAutomation,
  WorkboardHealthNode,
  WorkboardHealthProfile,
  WorkboardHealthResult,
  WorkboardHealthUnknown,
} from "@openclaw/workboard-contract";
import type { AuthProfileStore } from "openclaw/plugin-sdk/agent-runtime";
import { resolveAgentDir } from "openclaw/plugin-sdk/agent-scope-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { OpenClawPluginServiceContext, PluginRuntime } from "openclaw/plugin-sdk/core";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { resolveGlobalSingleton } from "openclaw/plugin-sdk/global-singleton";
import type { OpenClawPluginService } from "../api.js";
import type { WorkboardStore } from "./store.js";

type HealthBoard = Pick<
  WorkboardBoardSummary,
  "id" | "automationJobId" | "orchestration" | "archivedAt"
>;
type ServiceCron = NonNullable<ReturnType<NonNullable<OpenClawPluginServiceContext["getCron"]>>>;
type CronJob = Awaited<ReturnType<ServiceCron["list"]>>[number];
type RuntimeNode = Awaited<ReturnType<PluginRuntime["nodes"]["list"]>>["nodes"][number];
type ProfileUsage = NonNullable<AuthProfileStore["usageStats"]>[string];

/** The agents, jobs, and nodes the unarchived boards depend on, each job and node with its boards. */
export type WorkboardHealthScope = {
  agentIds: string[];
  jobBoards: Map<string, string[]>;
  nodeBoards: Map<string, string[]>;
};

export type WorkboardHealthAccountFacts = Omit<WorkboardHealthAccount, "profiles"> & {
  profiles: Array<{ profileId: string; usage?: ProfileUsage }> | WorkboardHealthUnknown;
};

export type WorkboardHealthFacts = {
  jobs: readonly CronJob[] | WorkboardHealthUnknown;
  nodes: readonly RuntimeNode[] | WorkboardHealthUnknown;
  accounts: readonly WorkboardHealthAccountFacts[] | WorkboardHealthUnknown;
};

export type WorkboardHealthReader = {
  read: (input?: { agentId?: string }) => Promise<WorkboardHealthResult>;
};

type SchedulerState = { getCron?: OpenClawPluginServiceContext["getCron"] };

const HEALTH_SCHEDULER_STATE_KEY = Symbol.for("openclaw.workboard.healthScheduler");

// Prepared model generations register the tools without starting the services,
// so the tool reaches the started service's scheduler through shared state.
function schedulerState(): SchedulerState {
  return resolveGlobalSingleton<SchedulerState>(
    HEALTH_SCHEDULER_STATE_KEY,
    () => ({}),
    (state) => {
      state.getCron = undefined;
    },
  );
}

function isUnknown(
  fact: readonly unknown[] | WorkboardHealthUnknown,
): fact is WorkboardHealthUnknown {
  return !Array.isArray(fact);
}

function addBoard(index: Map<string, string[]>, key: string | undefined, boardId: string): void {
  if (key) {
    index.set(key, [...(index.get(key) ?? []), boardId]);
  }
}

export function workboardHealthScope(
  boards: readonly HealthBoard[],
  callerAgentId: string | undefined,
): WorkboardHealthScope {
  const agentIds = new Set(callerAgentId ? [callerAgentId] : []);
  const jobBoards = new Map<string, string[]>();
  const nodeBoards = new Map<string, string[]>();
  for (const board of boards) {
    if (board.archivedAt) {
      continue;
    }
    const orchestration = board.orchestration;
    if (orchestration?.defaultAssignee) {
      agentIds.add(orchestration.defaultAssignee);
    }
    addBoard(jobBoards, board.automationJobId, board.id);
    addBoard(nodeBoards, orchestration?.defaultTarget?.nodeId, board.id);
    for (const route of orchestration?.targetRoutes ?? []) {
      for (const target of [route.target, ...(route.alternateTargets ?? [])]) {
        addBoard(nodeBoards, target.nodeId, board.id);
      }
    }
  }
  return { agentIds: [...agentIds].toSorted(), jobBoards, nodeBoards };
}

function automationRow(job: CronJob, boardIds: string[]): WorkboardHealthAutomation {
  const state = job.state;
  const lastError = state?.lastError ?? state?.lastDeliveryError;
  return {
    id: job.id,
    boardIds,
    exists: true,
    ...(job.name ? { name: job.name } : {}),
    ...(job.agentId ? { agentId: job.agentId } : {}),
    enabled: job.enabled !== false,
    ...(state?.lastRunStatus ? { lastRunStatus: state.lastRunStatus } : {}),
    ...(state?.lastRunAtMs === undefined ? {} : { lastRunAt: state.lastRunAtMs }),
    ...(lastError ? { lastError } : {}),
    ...(state?.nextRunAtMs === undefined ? {} : { nextRunAt: state.nextRunAtMs }),
    ...(state?.runningAtMs === undefined ? {} : { runningSince: state.runningAtMs }),
    ...(state?.consecutiveErrors === undefined
      ? {}
      : { consecutiveErrors: state.consecutiveErrors }),
    ...(state?.lastTriggerEvalAtMs === undefined
      ? {}
      : { lastTriggerEvalAt: state.lastTriggerEvalAtMs }),
    ...(state?.triggerEvalCount === undefined ? {} : { triggerEvalCount: state.triggerEvalCount }),
  };
}

function projectAutomations(
  scope: WorkboardHealthScope,
  jobs: readonly CronJob[],
): WorkboardHealthAutomation[] {
  const rows = jobs.flatMap((job) => {
    const boardIds = scope.jobBoards.get(job.id);
    return boardIds || (job.agentId && scope.agentIds.includes(job.agentId))
      ? [automationRow(job, boardIds ?? [])]
      : [];
  });
  const known = new Set(jobs.map((job) => job.id));
  for (const [id, boardIds] of scope.jobBoards) {
    if (!known.has(id)) {
      rows.push({ id, boardIds, exists: false });
    }
  }
  return rows.toSorted((left, right) => left.id.localeCompare(right.id));
}

function projectNodes(
  scope: WorkboardHealthScope,
  nodes: readonly RuntimeNode[],
): WorkboardHealthNode[] {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  return [...scope.nodeBoards]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([nodeId, boardIds]) => nodeRow(nodeId, boardIds, byId.get(nodeId)));
}

function nodeRow(
  nodeId: string,
  boardIds: string[],
  node: RuntimeNode | undefined,
): WorkboardHealthNode {
  if (!node) {
    return { nodeId, boardIds, paired: false };
  }
  return {
    nodeId,
    boardIds,
    paired: true,
    ...(node.displayName ? { displayName: node.displayName } : {}),
    connected: node.connected === true,
    ...(node.lastSeenAtMs === undefined ? {} : { lastSeenAt: node.lastSeenAtMs }),
  };
}

function profileHealth(
  profileId: string,
  usage: ProfileUsage | undefined,
  now: number,
): WorkboardHealthProfile {
  const windows = [
    ["disabled", usage?.disabledUntil, usage?.disabledReason],
    ["blocked", usage?.blockedUntil, usage?.blockedReason],
    ["cooldown", usage?.cooldownUntil, usage?.cooldownClassification ?? usage?.cooldownReason],
  ] as const;
  for (const [status, until, reason] of windows) {
    if (until !== undefined && until > now) {
      return { profileId, status, until, ...(reason ? { reason } : {}) };
    }
  }
  return { profileId, status: "ok" };
}

function projectAccounts(
  accounts: readonly WorkboardHealthAccountFacts[],
  now: number,
): WorkboardHealthAccount[] {
  return accounts
    .map(({ agentId, provider, model, profiles }) => ({
      agentId,
      provider,
      model,
      profiles: isUnknown(profiles)
        ? profiles
        : profiles.map(({ profileId, usage }) => profileHealth(profileId, usage, now)),
    }))
    .toSorted((left, right) => left.agentId.localeCompare(right.agentId));
}

/**
 * Projects the factory's operational state from the scheduler's jobs, the
 * paired nodes, and the agents' auth profile windows, for the boards in
 * `scope`. Pure and never stored; a fact read as `unknown` passes through.
 */
export function projectWorkboardHealth(
  scope: WorkboardHealthScope,
  facts: WorkboardHealthFacts,
  now: number,
): WorkboardHealthResult {
  return {
    generatedAt: now,
    automations: isUnknown(facts.jobs) ? facts.jobs : projectAutomations(scope, facts.jobs),
    nodes: isUnknown(facts.nodes) ? facts.nodes : projectNodes(scope, facts.nodes),
    accounts: isUnknown(facts.accounts) ? facts.accounts : projectAccounts(facts.accounts, now),
  };
}

async function readFact<T>(read: () => Promise<T>): Promise<T | WorkboardHealthUnknown> {
  try {
    return await read();
  } catch (error) {
    return { status: "unknown", reason: formatErrorMessage(error) };
  }
}

/**
 * Reads the health facts through the plugin's service-owned scheduler handle,
 * the node runtime, and each agent's read-only auth profile store.
 */
export function createWorkboardHealthService(params: {
  store: Pick<WorkboardStore, "listBoards">;
  runtime: {
    config: Pick<PluginRuntime["config"], "current">;
    nodes: Pick<PluginRuntime["nodes"], "list">;
    modelConfig: Pick<PluginRuntime["modelConfig"], "resolveDefaultModelForAgent">;
    modelAuth: Pick<
      PluginRuntime["modelAuth"],
      "ensureAuthProfileStoreAsync" | "listProfilesForProvider"
    >;
  };
}): OpenClawPluginService & WorkboardHealthReader {
  const { store, runtime } = params;
  let owned: OpenClawPluginServiceContext["getCron"];

  const readJobs = async () => {
    const cron = schedulerState().getCron?.();
    if (!cron) {
      throw new Error("The Workboard health service is not running, so no scheduler is readable.");
    }
    return await cron.list({ includeDisabled: true });
  };

  const readAccount = async (
    cfg: OpenClawConfig,
    agentId: string,
  ): Promise<WorkboardHealthAccountFacts> => {
    const { provider, model } = runtime.modelConfig.resolveDefaultModelForAgent({ cfg, agentId });
    const profiles = await readFact(async () => {
      const authStore = await runtime.modelAuth.ensureAuthProfileStoreAsync(
        resolveAgentDir(cfg, agentId),
        {
          readOnly: true,
          allowKeychainPrompt: false,
          config: cfg,
          externalCli: { mode: "none" },
        },
      );
      return runtime.modelAuth
        .listProfilesForProvider(authStore, provider)
        .map((profileId) => ({ profileId, usage: authStore.usageStats?.[profileId] }));
    });
    return { agentId, provider, model, profiles };
  };

  return {
    id: "workboard-health",
    start(ctx) {
      schedulerState().getCron = owned = ctx.getCron;
    },
    stop() {
      const state = schedulerState();
      if (state.getCron === owned) {
        state.getCron = undefined;
      }
      owned = undefined;
    },
    async read(input = {}) {
      const now = Date.now();
      const scope = workboardHealthScope((await store.listBoards()).boards, input.agentId);
      // The model-selection readers only read the snapshot; their SDK types predate DeepReadonly.
      const cfg = runtime.config.current() as OpenClawConfig;
      const [jobs, nodes, accounts] = await Promise.all([
        readFact(readJobs),
        readFact(async () => (await runtime.nodes.list()).nodes),
        readFact(() => Promise.all(scope.agentIds.map((agentId) => readAccount(cfg, agentId)))),
      ]);
      return projectWorkboardHealth(scope, { jobs, nodes, accounts }, now);
    },
  };
}
