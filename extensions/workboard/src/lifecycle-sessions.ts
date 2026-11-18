import { parseAgentSessionKey } from "openclaw/plugin-sdk/routing";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { OpenClawPluginApi } from "../api.js";

const WORKBOARD_SESSION_LOOKUP_LIMIT = 2;

export type WorkboardLifecycleSession = {
  key: string;
  updatedAt?: number;
  status?: "running" | "done" | "failed" | "killed" | "timeout";
  hasActiveRun?: boolean;
  abortedLastRun?: boolean;
};

export type WorkboardLifecycleSessionSnapshot = {
  sessions: WorkboardLifecycleSession[];
  complete: boolean;
};

export type WorkboardLifecycleSweep = {
  agentIds?: Promise<string[]>;
};

export type WorkboardLifecycleSessionReadOptions = {
  sessionKey: string;
  sweep?: WorkboardLifecycleSweep;
};

export type WorkboardLifecycleSessionReader = (
  options: WorkboardLifecycleSessionReadOptions,
) => Promise<WorkboardLifecycleSessionSnapshot>;

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
  gateway: Pick<OpenClawPluginApi["runtime"]["gateway"], "isAvailable"> & {
    request: (
      ...args: Parameters<OpenClawPluginApi["runtime"]["gateway"]["request"]>
    ) => Promise<unknown>;
  },
  options: WorkboardLifecycleSessionReadOptions,
): Promise<WorkboardLifecycleSessionSnapshot> {
  if (!(await gateway.isAvailable())) {
    return { sessions: [], complete: false };
  }
  if (parseAgentSessionKey(options.sessionKey)) {
    const payload = await gateway.request(
      "sessions.describe",
      { key: options.sessionKey, includeDerivedTitles: false, includeLastMessage: false },
      { scopes: ["operator.read"] },
    );
    if (!isRecord(payload) || (payload.session !== null && !isRecord(payload.session))) {
      throw new Error("sessions.describe returned an invalid lifecycle snapshot");
    }
    const session = normalizeSession(payload.session);
    // Completeness is scoped to the requested identity, never the catalog.
    return { sessions: session ? [session] : [], complete: true };
  }
  if (options.sessionKey.startsWith("subagent:workboard-")) {
    // Success and failure are shared only within this admitted sweep.
    const sweep: WorkboardLifecycleSweep = options.sweep ?? {};
    sweep.agentIds ??= gateway
      .request("agents.list", {}, { scopes: ["operator.read"] })
      .then((payload) => {
        if (!isRecord(payload) || !Array.isArray(payload.agents)) {
          throw new Error("agents.list returned an invalid ownership snapshot");
        }
        return payload.agents.map((agent) => {
          if (!isRecord(agent) || typeof agent.id !== "string" || !agent.id) {
            throw new Error("agents.list returned an invalid agent identity");
          }
          return agent.id;
        });
      });
    const sessions: WorkboardLifecycleSession[] = [];
    for (const agentId of await sweep.agentIds) {
      const exact = await readWorkboardLifecycleSessions(gateway, {
        sessionKey: `agent:${agentId}:${options.sessionKey}`,
      });
      if (!exact.complete) {
        return { sessions: [], complete: false };
      }
      sessions.push(...exact.sessions);
    }
    return { sessions, complete: true };
  }
  let includeUnknown = false;
  if (options.sessionKey === "unknown") {
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
      source: "workboard-lifecycle",
      rowMode: "compact",
      search: options.sessionKey,
      limit: WORKBOARD_SESSION_LOOKUP_LIMIT,
      configuredAgentsOnly: true,
      archived: "all",
      includeGlobal: false,
      includeUnknown,
    },
    { scopes: ["operator.read"] },
  );
  if (!isRecord(payload) || !Array.isArray(payload.sessions)) {
    throw new Error("sessions.list returned an invalid lifecycle snapshot");
  }
  const sessions = payload.sessions.flatMap((value) => {
    const session = normalizeSession(value);
    return session ? [session] : [];
  });
  return {
    sessions,
    // An exact hit establishes this identity despite unrelated title matches.
    // Otherwise, only a short page can prove absence or a unique suffix owner.
    complete:
      sessions.some((session) => session.key === options.sessionKey) ||
      payload.sessions.length < WORKBOARD_SESSION_LOOKUP_LIMIT,
  };
}
