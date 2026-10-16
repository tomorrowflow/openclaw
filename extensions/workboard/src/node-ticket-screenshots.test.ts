import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { WorkboardCard, WorkboardNodeRound } from "@openclaw/workboard-contract";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, expect, it } from "vitest";
import { listNodeTicketScreenshots, readNodeTicketScreenshot } from "./node-ticket-screenshots.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let repo = "";
beforeEach(() => {
  repo = tempDirs.make("wb-screenshots-");
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

it("lists an image the round moved, whatever diff.renames says", async () => {
  const base = commit({ "docs/draft.png": Buffer.from([1, 2, 3]) });
  fs.mkdirSync(path.join(repo, "docs/screenshots/T-1"), { recursive: true });
  fs.renameSync(
    path.join(repo, "docs/draft.png"),
    path.join(repo, "docs/screenshots/T-1/card.png"),
  );
  const moved = commit({});
  git("config", "diff.renames", "true");

  expect(
    await listNodeTicketScreenshots(nodeCard([{ round: 0, changes: changes(base, moved) }])),
  ).toEqual({ rounds: [{ round: 0, commit: moved, paths: ["docs/screenshots/T-1/card.png"] }] });
});

it("lists no rounds, without failing, when the readable rounds committed no image", async () => {
  const base = commit({ "README.md": "base" });
  const notes = commit({ "NOTES.md": "notes" });
  const card = nodeCard([
    { round: 0, changes: changes(base, notes) },
    { round: 1, changes: changes(notes, "f".repeat(40)) },
  ]);

  expect(await listNodeTicketScreenshots(card)).toEqual({ rounds: [] });
});

it("fails the listing when every round's commits are gone", async () => {
  const card = nodeCard([{ round: 0, changes: changes("e".repeat(40), "f".repeat(40)) }]);

  await expect(listNodeTicketScreenshots(card)).rejects.toThrow("no round's commits are left");
});

it("reports a broken host clone instead of skipping its rounds", async () => {
  const base = commit({ "README.md": "base" });
  const shot = commit({ "docs/screenshots/T-1/card.png": Buffer.from([1]) });
  const card = nodeCard([{ round: 0, changes: changes(base, shot) }]);
  fs.rmSync(path.join(repo, ".git"), { recursive: true });

  await expect(listNodeTicketScreenshots(card)).rejects.toThrow("host git diff");
  await expect(readNodeTicketScreenshot(card, 0, "docs/screenshots/T-1/card.png")).rejects.toThrow(
    "host git diff",
  );
});

it("lists nothing for a card without imported rounds", async () => {
  expect(await listNodeTicketScreenshots(nodeCard([{ round: 0 }]))).toEqual({ rounds: [] });
});

it("lists the remaining rounds when one round's commits are gone from the host clone", async () => {
  const base = commit({ "README.md": "base" });
  const shot = commit({ "docs/screenshots/T-1/card.png": Buffer.from([1]) });
  const card = nodeCard([
    { round: 0, changes: changes(base, "f".repeat(40)) },
    { round: 1, changes: changes(base, shot) },
  ]);

  expect(await listNodeTicketScreenshots(card)).toEqual({
    rounds: [{ round: 1, commit: shot, paths: ["docs/screenshots/T-1/card.png"] }],
  });
});

it("refuses commit ids that are not object names before running git", async () => {
  const base = commit({ "README.md": "base" });
  const shot = commit({ "docs/screenshots/T-1/card.png": Buffer.from([1]) });
  const card = nodeCard([{ round: 0, changes: changes("--output=/dev/null", shot) }]);

  await expect(listNodeTicketScreenshots(card)).rejects.toThrow("are not commit ids");
  await expect(
    readNodeTicketScreenshot(
      nodeCard([{ round: 0, changes: changes(base, "HEAD") }]),
      0,
      "docs/screenshots/T-1/card.png",
    ),
  ).rejects.toThrow("are not commit ids");
});

it("refuses a listed screenshot over 8 MB", async () => {
  const base = commit({ "README.md": "base" });
  const big = commit({ "docs/screenshots/T-1/big.png": Buffer.alloc(8 * 1024 * 1024 + 1) });
  const card = nodeCard([{ round: 0, changes: changes(base, big) }]);

  await expect(readNodeTicketScreenshot(card, 0, "docs/screenshots/T-1/big.png")).rejects.toThrow(
    "over the 8388608-byte limit",
  );
});
