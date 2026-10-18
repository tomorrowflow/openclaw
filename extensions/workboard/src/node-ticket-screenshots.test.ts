import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  WorkboardCard,
  WorkboardNodeRound,
  WorkboardNodeWorktree,
  WorkboardScreenshotRound,
} from "@openclaw/workboard-contract";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, expect, it } from "vitest";
import { listNodeTicketScreenshots, readNodeTicketScreenshot } from "./node-ticket-screenshots.js";
import type { WorkboardNodeTicketRuntime } from "./node-ticket.js";

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

/** Node replies are decided by the command; the fake answers the ones the screenshot path calls. */
function nodeRuntime(
  respond: (method: string, params: Record<string, unknown>) => unknown,
): WorkboardNodeTicketRuntime {
  return {
    request: async <T>(method: string, params?: Record<string, unknown>) =>
      (await respond(method, params ?? {})) as T,
  };
}

const noNode = nodeRuntime(() => {
  throw new Error("a card without a node worktree must not reach its node");
});

const imported: WorkboardNodeWorktree["handoff"] = {
  phase: "imported",
  headCommit: "a".repeat(40),
  importedAt: 1,
};

function committed(rounds: WorkboardScreenshotRound[]) {
  return { committed: { state: "available", rounds }, live: { state: "none" } };
}

function nodeCard(
  rounds: WorkboardNodeRound[],
  options: { handoff?: WorkboardNodeWorktree["handoff"]; screenshotDirs?: string[] } = {
    handoff: imported,
  },
): WorkboardCard {
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
          ...(options.screenshotDirs ? { screenshotDirs: options.screenshotDirs } : {}),
          worktree: {
            path: "/wt/card-1",
            branch: "factory/card-1",
            baseCommit: "",
            rounds,
            ...(options.handoff ? { handoff: options.handoff } : {}),
          },
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

  expect(await listNodeTicketScreenshots(noNode, card)).toEqual(
    committed([
      {
        round: 0,
        commit: first,
        paths: ["docs/screenshots/T-1/card-dark.png", "docs/screenshots/T-1/card-light.png"],
      },
      { round: 1, commit: rework, paths: ["docs/screenshots/T-1/card-light.png"] },
    ]),
  );
  expect(
    await readNodeTicketScreenshot(
      noNode,
      card,
      { round: 0 },
      "docs/screenshots/T-1/card-light.png",
    ),
  ).toEqual({
    mimeType: "image/png",
    contentBase64: png.toString("base64"),
  });
  for (const [round, file] of [
    [0, "docs/old.png"],
    [0, "docs/screenshots/T-1/README.md"],
    [1, "docs/screenshots/T-1/card-dark.png"],
  ] as const) {
    await expect(readNodeTicketScreenshot(noNode, card, { round }, file)).rejects.toThrow(
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
    await listNodeTicketScreenshots(
      noNode,
      nodeCard([{ round: 0, changes: changes(base, moved) }]),
    ),
  ).toEqual(committed([{ round: 0, commit: moved, paths: ["docs/screenshots/T-1/card.png"] }]));
});

it("lists no rounds, without failing, when the readable rounds committed no image", async () => {
  const base = commit({ "README.md": "base" });
  const notes = commit({ "NOTES.md": "notes" });
  const card = nodeCard([
    { round: 0, changes: changes(base, notes) },
    { round: 1, changes: changes(notes, "f".repeat(40)) },
  ]);

  expect(await listNodeTicketScreenshots(noNode, card)).toEqual(committed([]));
});

it("reports the committed screenshots unavailable when every round's commits are gone", async () => {
  const card = nodeCard([{ round: 0, changes: changes("e".repeat(40), "f".repeat(40)) }]);

  expect((await listNodeTicketScreenshots(noNode, card)).committed).toEqual({
    state: "unavailable",
    reason: `no round's commits are left in ${repo}`,
  });
});

it("reports a broken host clone instead of skipping its rounds", async () => {
  const base = commit({ "README.md": "base" });
  const shot = commit({ "docs/screenshots/T-1/card.png": Buffer.from([1]) });
  const card = nodeCard([{ round: 0, changes: changes(base, shot) }]);
  fs.rmSync(path.join(repo, ".git"), { recursive: true });

  expect((await listNodeTicketScreenshots(noNode, card)).committed).toMatchObject({
    state: "unavailable",
    reason: expect.stringContaining("host git diff"),
  });
  await expect(
    readNodeTicketScreenshot(noNode, card, { round: 0 }, "docs/screenshots/T-1/card.png"),
  ).rejects.toThrow("host git diff");
});

it("lists nothing for a card without imported rounds", async () => {
  expect(await listNodeTicketScreenshots(noNode, nodeCard([{ round: 0 }]))).toEqual(committed([]));
});

it("lists the remaining rounds when one round's commits are gone from the host clone", async () => {
  const base = commit({ "README.md": "base" });
  const shot = commit({ "docs/screenshots/T-1/card.png": Buffer.from([1]) });
  const card = nodeCard([
    { round: 0, changes: changes(base, "f".repeat(40)) },
    { round: 1, changes: changes(base, shot) },
  ]);

  expect(await listNodeTicketScreenshots(noNode, card)).toEqual(
    committed([{ round: 1, commit: shot, paths: ["docs/screenshots/T-1/card.png"] }]),
  );
});

it("refuses commit ids that are not object names before running git", async () => {
  const base = commit({ "README.md": "base" });
  const shot = commit({ "docs/screenshots/T-1/card.png": Buffer.from([1]) });
  const card = nodeCard([{ round: 0, changes: changes("--output=/dev/null", shot) }]);

  expect((await listNodeTicketScreenshots(noNode, card)).committed).toMatchObject({
    state: "unavailable",
    reason: expect.stringContaining("are not commit ids"),
  });
  await expect(
    readNodeTicketScreenshot(
      noNode,
      nodeCard([{ round: 0, changes: changes(base, "HEAD") }]),
      { round: 0 },
      "docs/screenshots/T-1/card.png",
    ),
  ).rejects.toThrow("are not commit ids");
});

it("refuses a listed screenshot over 8 MB", async () => {
  const base = commit({ "README.md": "base" });
  const big = commit({ "docs/screenshots/T-1/big.png": Buffer.alloc(8 * 1024 * 1024 + 1) });
  const card = nodeCard([{ round: 0, changes: changes(base, big) }]);

  await expect(
    readNodeTicketScreenshot(noNode, card, { round: 0 }, "docs/screenshots/T-1/big.png"),
  ).rejects.toThrow("over the 8388608-byte limit");
});

type FakeNodeFile = { bytes: Buffer; mtime: number };

/**
 * The file-transfer node commands over an in-memory worktree: `dir.list`
 * pages one directory, `file.fetch` returns base64 with its sha256. Paths
 * outside `allowed` answer like a policy denial.
 */
function fakeNode(files: Record<string, FakeNodeFile>, allowed = (_path: string) => true) {
  const calls: Array<{ command: string; path: string }> = [];
  const runtime = nodeRuntime((method, params) => {
    expect(method).toBe("node.invoke");
    const command = String(params.command);
    const target = (params.params as { path: string }).path;
    calls.push({ command, path: target });
    if (!allowed(target)) {
      return {
        payload: { ok: false, code: "PATH_POLICY_DENIED", message: `${command} denied` },
      };
    }
    if (command === "file.fetch") {
      const file = files[target];
      return {
        payload: file
          ? {
              ok: true,
              base64: file.bytes.toString("base64"),
              sha256: createHash("sha256").update(file.bytes).digest("hex"),
            }
          : { ok: false, code: "NOT_FOUND", message: "file not found" },
      };
    }
    const children = new Map<string, { isDir: boolean; file?: FakeNodeFile }>();
    for (const [filePath, file] of Object.entries(files)) {
      if (!filePath.startsWith(`${target}/`)) {
        continue;
      }
      const [name, ...rest] = filePath.slice(target.length + 1).split("/");
      children.set(name!, rest.length > 0 ? { isDir: true } : { isDir: false, file });
    }
    if (children.size === 0) {
      return { payload: { ok: false, code: "NOT_FOUND", message: "path not found" } };
    }
    return {
      payload: {
        ok: true,
        path: target,
        entries: [...children].map(([name, child]) => ({
          name,
          path: `${target}/${name}`,
          isDir: child.isDir,
          isFile: !child.isDir,
          size: child.file?.bytes.length ?? 0,
          mtime: child.file?.mtime ?? 0,
        })),
      },
    };
  });
  return { runtime, calls };
}

const running = { handoff: undefined, screenshotDirs: ["docs/screenshots", "features/evidence"] };

it("lists a running ticket's worktree images newest first, nested runs included, and reads one live", async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const node = fakeNode({
    "/wt/card-1/docs/screenshots/T-1/home.png": { bytes: png, mtime: 200 },
    "/wt/card-1/docs/screenshots/T-1/notes.md": { bytes: Buffer.from("x"), mtime: 900 },
    "/wt/card-1/features/evidence/ios-run-3/login.jpg": { bytes: Buffer.from([9]), mtime: 300 },
    "/wt/card-1/features/evidence/ios-run-3/a/b/too-deep.png": { bytes: png, mtime: 999 },
    "/wt/card-1/src/app.png": { bytes: png, mtime: 500 },
  });
  const card = nodeCard([], running);

  expect(await listNodeTicketScreenshots(node.runtime, card, () => 42)).toEqual({
    committed: { state: "available", rounds: [] },
    live: {
      state: "available",
      listedAt: 42,
      shots: [
        { path: "features/evidence/ios-run-3/login.jpg", bytes: 1, mtimeMs: 300 },
        { path: "docs/screenshots/T-1/home.png", bytes: png.length, mtimeMs: 200 },
      ],
    },
  });
  expect(
    await readNodeTicketScreenshot(
      node.runtime,
      card,
      { live: true },
      "docs/screenshots/T-1/home.png",
    ),
  ).toEqual({ mimeType: "image/png", contentBase64: png.toString("base64") });
});

it("lists the default docs/screenshots dir, empty until the agent creates it", async () => {
  const node = fakeNode({});
  const card = nodeCard([], { handoff: { phase: "pending", reportedAt: 1 } });

  expect((await listNodeTicketScreenshots(node.runtime, card, () => 7)).live).toEqual({
    state: "available",
    listedAt: 7,
    shots: [],
  });
  expect(node.calls).toEqual([{ command: "dir.list", path: "/wt/card-1/docs/screenshots" }]);
});

it("reports live unavailable with the grants to add, keeping the committed rounds", async () => {
  const base = commit({ "README.md": "base" });
  const shot = commit({ "docs/screenshots/T-1/card.png": Buffer.from([1]) });
  const card = nodeCard([{ round: 0, changes: changes(base, shot) }], running);
  const denied = fakeNode({}, () => false);
  const offline = nodeRuntime(() => {
    throw new Error("node factory is not connected");
  });

  for (const [runtime, cause] of [
    [
      denied.runtime,
      "could not list /wt/card-1/docs/screenshots: PATH_POLICY_DENIED dir.list denied",
    ],
    [offline, "node factory is not connected"],
  ] as const) {
    const listed = await listNodeTicketScreenshots(runtime, card);
    expect(listed.committed).toEqual({
      state: "available",
      rounds: [{ round: 0, commit: shot, paths: ["docs/screenshots/T-1/card.png"] }],
    });
    expect(listed.live).toEqual({
      state: "unavailable",
      reason: expect.stringContaining(cause),
    });
    expect(listed.live).toMatchObject({
      reason: expect.stringContaining(
        "gateway.nodes.commands.allow includes dir.list and file.fetch",
      ),
    });
  }
});

it("lists no live screenshots once the round is imported and the worktree removed", async () => {
  const node = fakeNode({
    "/wt/card-1/docs/screenshots/a.png": { bytes: Buffer.from([1]), mtime: 1 },
  });

  for (const handoff of [
    imported,
    { ...imported, phase: "published" as const, publishedAt: 2, pullRequestUrl: "u" },
  ]) {
    expect((await listNodeTicketScreenshots(node.runtime, nodeCard([], { handoff }))).live).toEqual(
      {
        state: "none",
      },
    );
  }
  expect(node.calls).toEqual([]);
});

it("refuses live reads outside the target's screenshot dirs before reaching the node", async () => {
  const node = fakeNode({
    "/wt/card-1/docs/screenshots/a.png": { bytes: Buffer.from([1]), mtime: 1 },
  });
  const card = nodeCard([], running);

  for (const escape of [
    "docs/screenshots/../../secret.png",
    "/wt/card-1/docs/screenshots/a.png",
    "src/app.png",
    "docs/screenshots-other/a.png",
    "docs/screenshots/a.md",
    "docs/screenshots//a.png",
    "docs/screenshots/a/b/c/deep.png",
  ]) {
    await expect(
      readNodeTicketScreenshot(node.runtime, card, { live: true }, escape),
    ).rejects.toThrow(`screenshot not found: live ${escape}`);
  }
  await expect(
    readNodeTicketScreenshot(
      node.runtime,
      nodeCard([], { handoff: imported }),
      { live: true },
      "docs/screenshots/a.png",
    ),
  ).rejects.toThrow("screenshot not found");
  expect(node.calls).toEqual([]);
});

it("refuses a live image whose bytes do not match the node's sha256", async () => {
  const card = nodeCard([], running);
  const runtime = nodeRuntime(() => ({
    payload: { ok: true, base64: Buffer.from([1]).toString("base64"), sha256: "0".repeat(64) },
  }));

  await expect(
    readNodeTicketScreenshot(runtime, card, { live: true }, "docs/screenshots/a.png"),
  ).rejects.toThrow("does not match its sha256");
});
