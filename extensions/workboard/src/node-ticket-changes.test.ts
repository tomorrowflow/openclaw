import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { WorkboardCard, WorkboardNodeRound } from "@openclaw/workboard-contract";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, expect, it } from "vitest";
import { readNodeTicketChangeDiff } from "./node-ticket-changes.js";
import { parseNumstat } from "./node-ticket-rounds.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let repo = "";
beforeEach(() => {
  repo = tempDirs.make("wb-changes-");
  git("init", "-q");
});

function git(...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
}

function commit(files: Record<string, string | null>): string {
  for (const [file, content] of Object.entries(files)) {
    const full = path.join(repo, file);
    if (content === null) {
      fs.rmSync(full);
      continue;
    }
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  git("add", "-A");
  git("commit", "-q", "-m", "c");
  return git("rev-parse", "HEAD").trim();
}

/** The round as the import records it, through the same numstat parse. */
function importedRound(round: number, from: string, to: string): WorkboardNodeRound {
  return {
    round,
    changes: parseNumstat(git("diff", "--numstat", "-z", "-M", from, to), from, to),
  };
}

function nodeCard(rounds: WorkboardNodeRound[]): WorkboardCard {
  return {
    id: "card-1",
    title: "Ticket",
    status: "review",
    priority: "normal",
    labels: [],
    position: 0,
    createdAt: 0,
    updatedAt: 0,
    metadata: {
      automation: {
        target: {
          kind: "node-claude",
          nodeId: "node",
          repoPath: "/repo",
          worktreesRoot: "/wt",
          hostRepoPath: repo,
          worktree: { path: "/wt/card-1", branch: "factory/card-1", baseCommit: "", rounds },
        },
      },
    },
  };
}

const body = Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n");

it("diffs one recorded file within its round, following a rename", async () => {
  const base = commit({ "src/a.ts": "one\n", "src/old.ts": `${body}\n`, "other.ts": "x\n" });
  const first = commit({ "src/a.ts": "two\n" });
  const rework = commit({
    "src/a.ts": "three\n",
    "src/old.ts": null,
    "src/new.ts": `${body}\nline 20\n`,
  });
  const card = nodeCard([importedRound(0, base, first), importedRound(1, first, rework)]);

  const roundZero = await readNodeTicketChangeDiff(card, 0, "src/a.ts");
  expect(roundZero.truncated).toBe(false);
  expect(roundZero.diff).toContain("-one\n+two");
  expect(roundZero.diff).not.toContain("three");

  const rename = (await readNodeTicketChangeDiff(card, 1, "src/new.ts")).diff;
  expect(rename).toContain("rename from src/old.ts\nrename to src/new.ts");
  expect(rename).toContain("+line 20");
});

it("refuses files the round did not record", async () => {
  const base = commit({ "src/a.ts": "one\n", "other.ts": "x\n" });
  const first = commit({ "src/a.ts": "two\n" });
  const card = nodeCard([importedRound(0, base, first)]);
  for (const [round, file] of [
    [0, "other.ts"],
    [1, "src/a.ts"],
  ] as const) {
    await expect(readNodeTicketChangeDiff(card, round, file)).rejects.toThrow(
      "changed file not found",
    );
  }
});

it("keeps a long diff's head and reads a glob-like file name literally", async () => {
  const big = Array.from({ length: 60_000 }, (_, index) => `generated line ${index}`).join("\n");
  const base = commit({ "dist/bundle.js": "old\n", "src/a.ts": "one\n" });
  const first = commit({ "dist/bundle.js": `${big}\n`, "src/a.ts": "two\n", "*": "star\n" });
  const card = nodeCard([importedRound(0, base, first)]);

  const long = await readNodeTicketChangeDiff(card, 0, "dist/bundle.js");
  expect(long.truncated).toBe(true);
  expect(long.diff.length).toBeLessThanOrEqual(200_000);
  expect(long.diff.startsWith("diff --git a/dist/bundle.js b/dist/bundle.js")).toBe(true);

  const star = (await readNodeTicketChangeDiff(card, 0, "*")).diff;
  expect(star).toContain("+star");
  expect(star).not.toContain("src/a.ts");
});
