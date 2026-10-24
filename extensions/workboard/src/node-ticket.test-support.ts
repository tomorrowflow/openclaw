import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WorkboardCard, WorkboardExecutionTarget } from "@openclaw/workboard-contract";
import { expect, vi } from "vitest";
import { dispatchAndStartWorkboardCards } from "./dispatcher.js";
import { syncWorkboardAgentEnded, type WorkboardLifecycleSessionReader } from "./lifecycle-sync.js";
import { createNodeTicketHandoffs } from "./node-ticket-handoff.js";
import type { WorkboardNodeTicketRuntime } from "./node-ticket.js";
import type { WorkboardStore } from "./store.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";

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
  // Closed PRs on the branch, newest first, by their head commit.
  const closedPulls: Array<{ html_url: string; sha: string; merged: boolean }> = [];
  const rejectCreate: { value?: { message: string; errors: Array<{ message: string }> } } = {};
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
    if (url.endsWith("/pulls") && method === "POST" && rejectCreate.value) {
      return new Response(JSON.stringify(rejectCreate.value), { status: 422 });
    }
    const reply = url.includes("/pulls?state=closed")
      ? closedPulls.map(({ html_url, sha, merged }) => ({
          html_url,
          number: Number(html_url.split("/").at(-1)),
          merged_at: merged ? "2026-10-19T14:07:34Z" : null,
          head: { sha },
        }))
      : url.includes("/pulls?")
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
    closedPulls,
    rejectCreate,
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

const tempRoots: string[] = [];

/** A temp dir that `removeTempRoots`, called from the suite's `afterEach`, removes. */
export function tempRoot(prefix: string): string {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

export function removeTempRoots(): void {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
}

export function reportMessages(report: Record<string, unknown>) {
  return [
    {
      role: "assistant",
      content: `Done.\n\n\`\`\`workboard-report\n${JSON.stringify(report)}\n\`\`\``,
    },
  ];
}

export const doneReport = reportMessages({
  outcome: "done",
  summary: "Parser accepts empty input",
  proof: [{ command: "pytest", status: "passed" }],
});

export const questionsReport = reportMessages({
  outcome: "needs_input",
  summary: "Empty input handling is ambiguous",
  questions: ["Should empty input return [] or raise? Default: return []."],
});

/** Starts a node card on local repos and lets it commit `files` in its worktree. */
export async function finishNodeTicket(params: {
  files?: Record<string, string>;
  uncommitted?: boolean;
  originCommits?: number;
  messages?: unknown[];
  onReview?: (card: WorkboardCard) => Promise<void>;
  readSessions?: WorkboardLifecycleSessionReader;
}) {
  const root = tempRoot("workboard-handoff-");
  const repos = createNodeRepos(root);
  for (let index = 0; index < (params.originCommits ?? 0); index += 1) {
    git(repos.origin, "commit", "-q", "--allow-empty", "-m", `merged ${index}`);
  }
  const store = createWorkboardSqliteTestStore();
  const gateway = createLocalNodeGateway();
  const { card, sessionKey, runId } = await startNodeCard(store, gateway, repos.target);
  const worktree = path.join(repos.target.worktreesRoot, `wb-${card.id}`);
  const files = Object.entries(params.files ?? { "parser.py": "ok\n" });
  for (const [name, body] of files) {
    writeFileSync(path.join(worktree, name), body);
  }
  if (files.length > 0 && !params.uncommitted) {
    git(worktree, "add", "-A");
    git(worktree, "commit", "-q", "-m", "fix parser");
  }
  await syncWorkboardAgentEnded({
    store,
    event: { runId, success: true, messages: params.messages ?? doneReport },
    context: { runId, sessionKey },
    readSessions: endedSession(),
  });
  const warn = vi.fn();
  const github = createFakeGitHub(repos.origin);
  const handoffs = createNodeTicketHandoffs({
    store,
    runtime: gateway,
    github: github.access,
    start: async (cardId, queue) =>
      await dispatchAndStartWorkboardCards({
        store,
        subagent: { run: vi.fn() },
        nodeTickets: gateway,
        options: { cardId, queue },
      }),
    ...(params.onReview ? { onReview: params.onReview } : {}),
    ...(params.readSessions ? { readSessions: params.readSessions } : {}),
  });
  // The handoff sweep runs on every card change, so it fires while a start
  // that claimed the card still carries the previous worktree record.
  const sweepingNodes = {
    request: (async (method, requestParams) => {
      const argv = (requestParams?.params as { command?: string[] } | undefined)?.command ?? [];
      if (argv.includes("worktree") && argv.includes("add")) {
        await handoffs.resume(warn);
      }
      return await gateway.request(method, requestParams);
    }) satisfies typeof gateway.request,
  };
  /** Re-runs the blocked card as an operator does; `work` is the session's turn. */
  const rerunDone = async (work?: () => void) => {
    const ready = await store.move(card.id, "ready", undefined);
    const { started } = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run: vi.fn() },
      nodeTickets: sweepingNodes,
      options: { now: ready.updatedAt, maxStarts: 1 },
    });
    expect(started[0]).toBeDefined();
    expect((await store.get(card.id))?.status).toBe("running");
    work?.();
    await syncWorkboardAgentEnded({
      store,
      event: { runId: started[0]?.runId, success: true, messages: doneReport },
      context: { runId: started[0]?.runId, sessionKey: started[0]?.sessionKey },
      readSessions: endedSession(),
    });
    await handoffs.resume(warn);
  };
  return {
    store,
    card,
    repos,
    worktree,
    handoffs,
    warn,
    gateway,
    github,
    rerunDone,
    sweepingNodes,
  };
}
