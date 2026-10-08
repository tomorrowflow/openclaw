import { vi } from "vitest";
import { dispatchAndStartWorkboardCards } from "./dispatcher.js";
import type { WorkboardNodeTicketRuntime } from "./node-ticket.js";
import type { WorkboardStore } from "./store.js";

export const BASE_COMMIT = "a".repeat(40);
export const NODE_TARGET = {
  kind: "node-claude",
  nodeId: "mac-factory",
  repoPath: "/Users/factory/factory/repos/app",
  worktreesRoot: "/Users/factory/factory/worktrees",
  baseRef: "main",
  model: "claude-cli/claude-sonnet-5-5",
} as const;

export function createNodeGateway(options: { failGit?: string; existingBranch?: string } = {}) {
  const respond = vi.fn((method: string, params?: Record<string, unknown>): unknown => {
    if (method === "node.invoke") {
      const nodeParams = params?.params as { command?: string[] } | undefined;
      const argv = nodeParams?.command ?? [];
      if (argv.includes("--abbrev-ref")) {
        return options.existingBranch
          ? { payload: { success: true, stdout: `${options.existingBranch}\n` } }
          : { payload: { success: false, stdout: "", stderr: "fatal: not a git repository" } };
      }
      if (options.failGit && argv.includes(options.failGit)) {
        return { payload: { success: false, stdout: "", stderr: "fatal: branch exists" } };
      }
      return {
        payload: { success: true, stdout: argv.includes("rev-parse") ? `${BASE_COMMIT}\n` : "" },
      };
    }
    if (method === "sessions.create") {
      return {
        ok: true,
        key: params?.key,
        runId: "run-node",
        runStarted: true,
        resolved: { modelProvider: "claude-cli", model: "claude-sonnet-5-5" },
      };
    }
    throw new Error(`unexpected gateway method ${method}`);
  });
  // Typed Gateway replies are decided by the method; the fake answers each one the ticket path calls.
  const request: WorkboardNodeTicketRuntime["request"] = async <T>(
    method: string,
    params?: Record<string, unknown>,
  ) => respond(method, params) as T;
  return { respond, request };
}

export async function createNodeCard(store: WorkboardStore) {
  return await store.create({
    title: "Fix the parser",
    status: "ready",
    agentId: "dev",
    workspaceAccess: { unrestricted: true },
    metadata: { automation: { target: NODE_TARGET } },
  });
}

/** Dispatches one node card through the real claim and launch path. */
export async function startNodeCard(store: WorkboardStore) {
  const card = await createNodeCard(store);
  const result = await dispatchAndStartWorkboardCards({
    store,
    subagent: { run: vi.fn() },
    nodeTickets: createNodeGateway(),
    options: { now: card.updatedAt, maxStarts: 1 },
  });
  const started = result.started[0];
  if (!started) {
    throw new Error(result.startFailures[0]?.error ?? "node card did not start");
  }
  return { card, sessionKey: started.sessionKey, runId: started.runId };
}
