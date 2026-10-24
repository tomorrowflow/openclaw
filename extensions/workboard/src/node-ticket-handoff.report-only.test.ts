// Workboard tests cover a node ticket round that reports done without committing anything.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { syncWorkboardAgentEnded } from "./lifecycle-sync.js";
import { createNodeTicketHandoffs } from "./node-ticket-handoff.js";
import {
  createFakeGitHub,
  createLocalNodeGateway,
  createNodeRepos,
  endedSession,
  git,
  startNodeCard,
} from "./node-ticket.test-support.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";
import { projectWorkboardTrust } from "./trust-kpis.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const report = {
  outcome: "done",
  summary: "Could not reproduce: empty input already parses",
  proof: [{ command: "pytest", status: "passed" }],
};

describe("node ticket report-only round", () => {
  it("settles a round without commits in review, and done closes it without a PR", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "workboard-report-only-"));
    roots.push(root);
    const repos = createNodeRepos(root);
    const store = createWorkboardSqliteTestStore();
    const gateway = createLocalNodeGateway();
    const { card, sessionKey, runId } = await startNodeCard(store, gateway, repos.target);
    const worktree = path.join(repos.target.worktreesRoot, `wb-${card.id}`);
    const branch = `factory/${card.id}`;
    const base = git(repos.target.repoPath, "rev-parse", "main");
    const messages = [
      {
        role: "assistant",
        content: `Done.\n\n\`\`\`workboard-report\n${JSON.stringify(report)}\n\`\`\``,
      },
    ];
    await syncWorkboardAgentEnded({
      store,
      event: { runId, success: true, messages },
      context: { runId, sessionKey },
      readSessions: endedSession(),
    });
    const github = createFakeGitHub(repos.origin);
    github.tokens.set("acme/app", "token-app");
    git(repos.hostRepo, "remote", "set-url", "origin", "git@github.com:acme/app.git");
    const handoffs = createNodeTicketHandoffs({
      store,
      runtime: gateway,
      github: github.access,
      start: async () => ({ startFailures: [] }),
    });
    const warn = vi.fn();

    await handoffs.resume(warn);

    const reviewed = await store.get(card.id);
    expect(warn).not.toHaveBeenCalled();
    expect(reviewed?.status).toBe("review");
    expect(reviewed?.metadata?.claim).toBeUndefined();
    expect(reviewed?.metadata?.automation?.target?.worktree).toMatchObject({ baseCommit: base });
    expect(reviewed?.metadata?.automation?.target?.worktree?.handoff).toBeUndefined();
    expect(reviewed?.metadata?.proof?.at(-1)).toMatchObject({
      label: "bundle import",
      status: "skipped",
      note: `No commits beyond ${base.slice(0, 12)}: report-only round, nothing to import or publish`,
    });
    expect(reviewed?.metadata?.comments?.at(-1)?.body).toBe(report.summary);
    expect(existsSync(worktree)).toBe(false);
    expect(git(repos.target.repoPath, "branch", "--list", branch)).toBe("");
    expect(git(repos.hostRepo, "branch", "--list", branch)).toBe("");

    await store.move(card.id, "done", undefined);
    await handoffs.resume(warn);

    const done = await store.get(card.id);
    expect(done?.status).toBe("done");
    expect(github.requests).toEqual([]);
    expect(projectWorkboardTrust(done ? [done] : [], "app", Date.now()).total).toMatchObject({
      accepted: 0,
      firstPass: 0,
    });
  });
});
