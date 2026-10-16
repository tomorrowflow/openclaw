import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WorkboardCard, WorkboardNodeRound } from "@openclaw/workboard-contract";
import { afterAll, expect, it } from "vitest";
import { listNodeTicketScreenshots, readNodeTicketScreenshot } from "./node-ticket-screenshots.js";

const repo = fs.mkdtempSync(path.join(os.tmpdir(), "wb-screenshots-"));
afterAll(() => fs.rmSync(repo, { recursive: true, force: true }));

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
  }).trim();
}

function commit(files: Record<string, Buffer | string>): string {
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), content);
  }
  git("add", "-A");
  git("commit", "-q", "-m", "c");
  return git("rev-parse", "HEAD");
}

function changes(from: string, to: string): NonNullable<WorkboardNodeRound["changes"]> {
  return { from, to, files: [], totals: { files: 0, added: 0, deleted: 0 } };
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

it("lists each round's committed images and serves their exact bytes, refusing other paths", async () => {
  git("init", "-q");
  const base = commit({ "README.md": "base", "docs/old.png": Buffer.from([1]) });
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x0a, 0x0d]);
  const first = commit({
    "docs/screenshots/T-1/card-light.png": png,
    "docs/screenshots/T-1/card-dark.png": Buffer.from([2]),
    "docs/screenshots/T-1/README.md": "notes",
  });
  const rework = commit({ "docs/screenshots/T-1/card-light.png": Buffer.from([3]) });
  const card = nodeCard([
    { round: 0, changes: changes(base, first) },
    { round: 1, changes: changes(first, rework) },
  ]);

  expect(await listNodeTicketScreenshots(card)).toEqual({
    rounds: [
      {
        round: 0,
        commit: first,
        paths: ["docs/screenshots/T-1/card-dark.png", "docs/screenshots/T-1/card-light.png"],
      },
      { round: 1, commit: rework, paths: ["docs/screenshots/T-1/card-light.png"] },
    ],
  });
  expect(await readNodeTicketScreenshot(card, 0, "docs/screenshots/T-1/card-light.png")).toEqual({
    mimeType: "image/png",
    contentBase64: png.toString("base64"),
  });
  for (const [round, file] of [
    [0, "docs/old.png"],
    [0, "docs/screenshots/T-1/README.md"],
    [1, "docs/screenshots/T-1/card-dark.png"],
  ] as const) {
    await expect(readNodeTicketScreenshot(card, round, file)).rejects.toThrow(
      "screenshot not found",
    );
  }
});

it("lists nothing for a card without imported rounds", async () => {
  expect(await listNodeTicketScreenshots(nodeCard([{ round: 0 }]))).toEqual({ rounds: [] });
});
