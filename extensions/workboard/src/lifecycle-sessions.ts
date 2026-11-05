import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { OpenClawPluginApi } from "../api.js";

const WORKBOARD_SESSION_SWEEP_LIMIT = 10_000;

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

export type WorkboardLifecycleSessionReadOptions = {
  includeUnknown: boolean;
  sessionKey?: string;
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
      archived: "all",
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
