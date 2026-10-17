import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { WorkboardExecutionTarget } from "@openclaw/workboard-contract";
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
  hostRepoPath: "/home/openclaw/repos/app",
  baseRef: "main",
  model: "anthropic/claude-sonnet-5-5",
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
      return sessionsCreateReply(params);
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

function sessionsCreateReply(params?: Record<string, unknown>, runId = "run-node") {
  return {
    ok: true,
    key: params?.key,
    runId,
    runStarted: true,
    resolved: { modelProvider: "anthropic", model: "claude-sonnet-5-5" },
  };
}

export function git(cwd: string, ...args: string[]): string {
  const result = spawnSync(
    "git",
    ["-C", cwd, "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

/**
 * An origin, a node clone and a host clone of it, and a worktrees root under
 * `root`; the node side is reached only through {@link createLocalNodeGateway}.
 */
export function createNodeRepos(root: string) {
  const origin = path.join(root, "origin");
  const nodeRepo = path.join(root, "node-repo");
  const hostRepo = path.join(root, "host-repo");
  const worktreesRoot = path.join(root, "worktrees");
  mkdirSync(worktreesRoot, { recursive: true });
  spawnSync("git", ["init", "-q", "-b", "main", origin]);
  git(origin, "commit", "-q", "--allow-empty", "-m", "base");
  spawnSync("git", ["clone", "-q", origin, nodeRepo]);
  spawnSync("git", ["clone", "-q", origin, hostRepo]);
  const { baseRef: _baseRef, ...target } = NODE_TARGET;
  return {
    origin,
    hostRepo,
    target: { ...target, repoPath: nodeRepo, worktreesRoot, hostRepoPath: hostRepo },
  };
}

/** Runs node commands against local paths, as a paired node would against its own disk. */
export function createLocalNodeGateway() {
  let runs = 0;
  const respond = vi.fn((method: string, params?: Record<string, unknown>): unknown => {
    const nodeParams = params?.params as { command?: string[]; path?: string } | undefined;
    if (method === "node.invoke" && params?.command === "system.run") {
      const [command = "", ...args] = nodeParams?.command ?? [];
      const result = spawnSync(command, args, { encoding: "utf8" });
      return {
        payload: { success: result.status === 0, stdout: result.stdout, stderr: result.stderr },
      };
    }
    if (method === "node.invoke" && params?.command === "file.fetch") {
      const bytes = readFileSync(nodeParams?.path ?? "");
      return {
        payload: {
          ok: true,
          path: nodeParams?.path,
          size: bytes.byteLength,
          base64: bytes.toString("base64"),
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
      };
    }
    if (method === "sessions.create") {
      runs += 1;
      return sessionsCreateReply(params, `run-node-${runs}`);
    }
    throw new Error(`unexpected gateway method ${method}`);
  });
  const request: WorkboardNodeTicketRuntime["request"] = async <T>(
    method: string,
    params?: Record<string, unknown>,
  ) => respond(method, params) as T;
  return { respond, request };
}

export async function createNodeCard(
  store: WorkboardStore,
  target: WorkboardExecutionTarget = NODE_TARGET,
  labels: string[] = [],
) {
  return await store.create({
    title: "Fix the parser",
    status: "ready",
    agentId: "dev",
    labels,
    workspaceAccess: { unrestricted: true },
    metadata: { automation: { target } },
  });
}

/** Dispatches one node card through the real claim and launch path. */
export async function startNodeCard(
  store: WorkboardStore,
  nodeTickets: WorkboardNodeTicketRuntime = createNodeGateway(),
  target?: WorkboardExecutionTarget,
  labels?: string[],
) {
  const card = await createNodeCard(store, target, labels);
  const result = await dispatchAndStartWorkboardCards({
    store,
    subagent: { run: vi.fn() },
    nodeTickets,
    options: { now: card.updatedAt, maxStarts: 1 },
  });
  const started = result.started[0];
  if (!started) {
    throw new Error(result.startFailures[0]?.error ?? "node card did not start");
  }
  return { card, sessionKey: started.sessionKey, runId: started.runId };
}

/**
 * The session owner's view of a run that ended, which agent_end reads before it
 * settles the card: `done` on success, `failed` otherwise.
 */
export function endedSession(success = true) {
  return async (options: { sessionKey?: string }) => ({
    sessions: options.sessionKey
      ? [
          {
            key: options.sessionKey,
            status: success ? ("done" as const) : ("failed" as const),
            hasActiveRun: false,
            updatedAt: Date.now(),
          },
        ]
      : [],
    complete: true,
  });
}

/**
 * The session owner's view after a run ended without failing the session, as
 * after a watchdog abort whose retry turn finished: no active run, no outcome.
 * The same session feeds agent_end and the sweep.
 */
export function settledSession(key: string) {
  const session = { key, hasActiveRun: false, updatedAt: Date.now() };
  return { session, readSessions: async () => ({ sessions: [session], complete: true }) };
}

/** A GitHub API stand-in for the publish step; pushes go to the local `remote`. */
export function createFakeGitHub(remote: string) {
  const tokens = new Map<string, string>();
  const openPulls: string[] = [];
  // Open PRs still in draft; the GraphQL ready mutation removes one by its node id.
  const draftPulls = new Set<string>();
  const failComments = { value: false };
  const failReady = { value: false };
  const requests: Array<{ method: string; url: string; auth?: string; body?: unknown }> = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    requests.push({ method, url, auth: headers.get("authorization") ?? undefined, body });
    if (url.endsWith("/comments") && failComments.value) {
      return new Response(JSON.stringify({ message: "Resource not accessible" }), { status: 403 });
    }
    if (url.endsWith("/graphql")) {
      const ready = failReady.value
        ? undefined
        : openPulls.find((html_url) => `PR_${html_url}` === body?.variables?.id);
      if (ready) {
        draftPulls.delete(ready);
      }
      return new Response(
        JSON.stringify(
          ready
            ? { data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } }
            : { errors: [{ message: "Could not resolve to a node" }] },
        ),
        { status: 200 },
      );
    }
    const reply = url.includes("/pulls?")
      ? openPulls.map((html_url) => ({
          html_url,
          number: Number(html_url.split("/").at(-1)),
          node_id: `PR_${html_url}`,
          draft: draftPulls.has(html_url),
        }))
      : method === "POST"
        ? { html_url: "https://github.com/acme/app/pull/7" }
        : { default_branch: "main" };
    return new Response(JSON.stringify(reply), { status: method === "POST" ? 201 : 200 });
  });
  return {
    tokens,
    openPulls,
    draftPulls,
    failComments,
    failReady,
    requests,
    access: {
      token: (repo: string) => tokens.get(repo),
      fetch: fetchImpl as unknown as typeof fetch,
      remoteUrl: () => remote,
    },
  };
}
