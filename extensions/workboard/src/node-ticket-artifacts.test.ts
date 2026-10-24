import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  WorkboardCard,
  WorkboardLink,
  WorkboardNodeRound,
  WorkboardNodeWorktree,
  WorkboardNodeFileRound,
  WorkboardNodeFileSource,
} from "@openclaw/workboard-contract";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  listNodeTicketArtifacts,
  readNodeTicketArtifact,
  relatedCardIds,
} from "./node-ticket-artifacts.js";
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

const listScreenshots = (
  runtime: WorkboardNodeTicketRuntime,
  card: WorkboardCard,
  options: { live: boolean; linked?: readonly WorkboardCard[]; now?: () => number },
) => listNodeTicketArtifacts(runtime, card, "screenshot", options);

async function readScreenshot(
  runtime: WorkboardNodeTicketRuntime,
  card: WorkboardCard,
  source: WorkboardNodeFileSource,
  path: string,
) {
  const { mimeType, bytes } = await readNodeTicketArtifact(
    runtime,
    card,
    "screenshot",
    source,
    path,
  );
  return { mimeType, contentBase64: bytes.toString("base64") };
}

const COMMITTED = { live: false };

const noNode = nodeRuntime(() => {
  throw new Error("a card without a node worktree must not reach its node");
});

const imported: WorkboardNodeWorktree["handoff"] = {
  phase: "imported",
  headCommit: "a".repeat(40),
  importedAt: 1,
};

function committed(rounds: WorkboardNodeFileRound[]) {
  return { committed: { state: "available", rounds } };
}

function nodeCard(
  rounds: WorkboardNodeRound[],
  options: {
    handoff?: WorkboardNodeWorktree["handoff"];
    screenshotDirs?: string[];
    baseCommit?: string;
    id?: string;
    title?: string;
    links?: WorkboardLink[];
  } = {
    handoff: imported,
  },
): WorkboardCard {
  return {
    id: options.id ?? "card-1",
    title: options.title ?? "Ticket",
    status: "review",
    priority: "normal",
    labels: [],
    position: 0,
    createdAt: 0,
    updatedAt: 0,
    metadata: {
      ...(options.links ? { links: options.links } : {}),
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
            baseCommit: options.baseCommit ?? "a".repeat(40),
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

  expect(await listScreenshots(noNode, card, COMMITTED)).toEqual(
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
    await readScreenshot(noNode, card, { round: 0 }, "docs/screenshots/T-1/card-light.png"),
  ).toEqual({
    mimeType: "image/png",
    contentBase64: png.toString("base64"),
  });
  for (const [round, file] of [
    [0, "docs/old.png"],
    [0, "docs/screenshots/T-1/README.md"],
    [1, "docs/screenshots/T-1/card-dark.png"],
  ] as const) {
    await expect(readScreenshot(noNode, card, { round }, file)).rejects.toThrow(
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
    await listScreenshots(
      noNode,
      nodeCard([{ round: 0, changes: changes(base, moved) }]),
      COMMITTED,
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

  expect(await listScreenshots(noNode, card, COMMITTED)).toEqual(committed([]));
});

it("reports the committed screenshots unavailable when every round's commits are gone", async () => {
  const card = nodeCard([{ round: 0, changes: changes("e".repeat(40), "f".repeat(40)) }]);

  expect((await listScreenshots(noNode, card, COMMITTED)).committed).toEqual({
    state: "unavailable",
    reason: `no round's commits are left in ${repo}`,
  });
});

it("reports a broken host clone instead of skipping its rounds", async () => {
  const base = commit({ "README.md": "base" });
  const shot = commit({ "docs/screenshots/T-1/card.png": Buffer.from([1]) });
  const card = nodeCard([{ round: 0, changes: changes(base, shot) }]);
  fs.rmSync(path.join(repo, ".git"), { recursive: true });

  expect((await listScreenshots(noNode, card, COMMITTED)).committed).toMatchObject({
    state: "unavailable",
    reason: expect.stringContaining("host git diff"),
  });
  await expect(
    readScreenshot(noNode, card, { round: 0 }, "docs/screenshots/T-1/card.png"),
  ).rejects.toThrow("host git diff");
});

it("lists nothing for a card without imported rounds", async () => {
  expect(await listScreenshots(noNode, nodeCard([{ round: 0 }]), COMMITTED)).toEqual(committed([]));
});

it("lists the remaining rounds when one round's commits are gone from the host clone", async () => {
  const base = commit({ "README.md": "base" });
  const shot = commit({ "docs/screenshots/T-1/card.png": Buffer.from([1]) });
  const card = nodeCard([
    { round: 0, changes: changes(base, "f".repeat(40)) },
    { round: 1, changes: changes(base, shot) },
  ]);

  expect(await listScreenshots(noNode, card, COMMITTED)).toEqual(
    committed([{ round: 1, commit: shot, paths: ["docs/screenshots/T-1/card.png"] }]),
  );
});

it("refuses commit ids that are not object names before running git", async () => {
  const base = commit({ "README.md": "base" });
  const shot = commit({ "docs/screenshots/T-1/card.png": Buffer.from([1]) });
  const card = nodeCard([{ round: 0, changes: changes("--output=/dev/null", shot) }]);

  expect((await listScreenshots(noNode, card, COMMITTED)).committed).toMatchObject({
    state: "unavailable",
    reason: expect.stringContaining("are not commit ids"),
  });
  await expect(
    readScreenshot(
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
    readScreenshot(noNode, card, { round: 0 }, "docs/screenshots/T-1/big.png"),
  ).rejects.toThrow("over the 8388608-byte limit");
});

type FakeNodeFile = { bytes: Buffer; mtime: number };

/**
 * The file-transfer node commands over an in-memory worktree: `dir.list`
 * pages one directory, `file.fetch` returns base64 with its sha256. Paths
 * outside `allowed` answer like a policy denial. `system.run` answers through
 * `runGit`; by default every file counts as changed by the round.
 */
function fakeNode(
  files: Record<string, FakeNodeFile>,
  allowed = (_path: string) => true,
  runGit: (argv: string[]) => string = (argv) =>
    argv.includes("diff")
      ? Object.keys(files)
          .map((file) => `${file.replace("/wt/card-1/", "")}\0`)
          .join("")
      : "",
) {
  const calls: Array<{ command: string; path: string }> = [];
  const runtime = nodeRuntime((method, params) => {
    expect(method).toBe("node.invoke");
    const command = String(params.command);
    if (command === "system.run") {
      const argv = (params.params as { command: string[] }).command;
      try {
        return { payload: { success: true, stdout: runGit(argv) } };
      } catch (error) {
        return { payload: { success: false, error: String(error) } };
      }
    }
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

  expect(await listScreenshots(node.runtime, card, { live: true })).toEqual({
    committed: { state: "available", rounds: [] },
    live: {
      state: "available",
      files: [
        { path: "features/evidence/ios-run-3/login.jpg", bytes: 1, mtimeMs: 300 },
        { path: "docs/screenshots/T-1/home.png", bytes: png.length, mtimeMs: 200 },
      ],
    },
  });
  expect(
    await readScreenshot(node.runtime, card, { live: true }, "docs/screenshots/T-1/home.png"),
  ).toEqual({ mimeType: "image/png", contentBase64: png.toString("base64") });
});

it("lists the default docs/screenshots dir, empty until the agent creates it", async () => {
  const node = fakeNode({});
  const card = nodeCard([], { handoff: { phase: "pending", reportedAt: 1 } });

  expect((await listScreenshots(node.runtime, card, { live: true })).live).toEqual({
    state: "available",
    files: [],
  });
  expect(node.calls).toEqual([{ command: "dir.list", path: "/wt/card-1/docs/screenshots" }]);
});

it("walks no node worktree when the list does not ask for live shots", async () => {
  expect(await listScreenshots(noNode, nodeCard([], running), COMMITTED)).toEqual(committed([]));
});

it("bounds the whole live walk by one deadline, shortening the last call's timeout", async () => {
  const timeouts: unknown[] = [];
  const runtime = nodeRuntime((_method, params) => {
    if (params.command === "system.run") {
      return { payload: { success: true, stdout: "" } };
    }
    timeouts.push(params.timeoutMs);
    return {
      payload: {
        ok: true,
        entries: [{ name: "run", isDir: true, isFile: false, size: 0, mtime: 0 }],
      },
    };
  });
  const clock = [0, 0, 25_000, 30_000];
  const now = () => clock.shift() ?? 30_000;

  const listed = await listScreenshots(runtime, nodeCard([], running), {
    live: true,
    now,
  });

  expect(timeouts).toEqual([20_000, 5_000]);
  expect(listed.live).toEqual({
    state: "unavailable",
    reason: expect.stringContaining("took over 30 seconds"),
  });
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
    const listed = await listScreenshots(runtime, card, { live: true });
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
        "gateway.nodes.commands.allow includes dir.list, file.fetch, and system.run",
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
    expect(
      (await listScreenshots(node.runtime, nodeCard([], { handoff }), { live: true })).live,
    ).toEqual({
      state: "none",
    });
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
    await expect(readScreenshot(node.runtime, card, { live: true }, escape)).rejects.toThrow(
      `screenshot not found: live ${escape}`,
    );
  }
  await expect(
    readScreenshot(
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
  const runtime = nodeRuntime((_method, params) => ({
    payload:
      params.command === "system.run"
        ? { success: true, stdout: "docs/screenshots/a.png\0" }
        : { ok: true, base64: Buffer.from([1]).toString("base64"), sha256: "0".repeat(64) },
  }));

  await expect(
    readScreenshot(runtime, card, { live: true }, "docs/screenshots/a.png"),
  ).rejects.toThrow("does not match its sha256");
});

it("lists only the HTML a round committed under docs/prototypes and serves its exact text", async () => {
  const base = commit({ "README.md": "base", "docs/prototypes/T-0/old.html": "<p>old</p>" });
  const html = "<!doctype html><button onclick=\"this.textContent='ok ✓'\">Try</button>";
  const first = commit({
    "docs/prototypes/T-1/flow.html": html,
    "docs/prototypes/T-1/legacy.HTM": "<p>legacy</p>",
    "docs/prototypes/T-1/notes.md": "notes",
    "docs/prototypes/T-1/shot.png": Buffer.from([1]),
    "index.html": "<p>the app itself</p>",
    "docs/guide.html": "<p>docs</p>",
  });
  const card = nodeCard([{ round: 0, changes: changes(base, first) }]);

  expect(await listNodeTicketArtifacts(noNode, card, "prototype", COMMITTED)).toEqual(
    committed([
      {
        round: 0,
        commit: first,
        paths: ["docs/prototypes/T-1/flow.html", "docs/prototypes/T-1/legacy.HTM"],
      },
    ]),
  );
  const read = await readNodeTicketArtifact(
    noNode,
    card,
    "prototype",
    { round: 0 },
    "docs/prototypes/T-1/flow.html",
  );
  expect(read.mimeType).toBe("text/html");
  expect(read.bytes.toString("utf8")).toBe(html);
  for (const file of ["index.html", "docs/guide.html", "docs/prototypes/T-0/old.html"]) {
    await expect(
      readNodeTicketArtifact(noNode, card, "prototype", { round: 0 }, file),
    ).rejects.toThrow(`prototype not found: round 0 ${file}`);
  }
});

it("refuses a listed prototype over 2 MiB", async () => {
  const base = commit({ "README.md": "base" });
  const big = commit({ "docs/prototypes/T-1/big.html": "x".repeat(2 * 1024 * 1024 + 1) });
  const card = nodeCard([{ round: 0, changes: changes(base, big) }]);

  await expect(
    readNodeTicketArtifact(noNode, card, "prototype", { round: 0 }, "docs/prototypes/T-1/big.html"),
  ).rejects.toThrow("over the 2097152-byte limit");
});

it("walks only docs/prototypes for a running ticket's live prototypes, whatever its screenshot dirs", async () => {
  const html = Buffer.from("<!doctype html><p>live</p>");
  const node = fakeNode({
    "/wt/card-1/docs/prototypes/T-1/flow.html": { bytes: html, mtime: 200 },
    "/wt/card-1/docs/prototypes/T-1/notes.md": { bytes: Buffer.from("x"), mtime: 900 },
    "/wt/card-1/docs/screenshots/T-1/page.html": { bytes: html, mtime: 300 },
  });
  const card = nodeCard([], running);

  expect(
    (await listNodeTicketArtifacts(node.runtime, card, "prototype", { live: true })).live,
  ).toEqual({
    state: "available",
    files: [{ path: "docs/prototypes/T-1/flow.html", bytes: html.length, mtimeMs: 200 }],
  });
  expect(node.calls).toEqual([
    { command: "dir.list", path: "/wt/card-1/docs/prototypes" },
    { command: "dir.list", path: "/wt/card-1/docs/prototypes/T-1" },
  ]);
  const read = await readNodeTicketArtifact(
    node.runtime,
    card,
    "prototype",
    { live: true },
    "docs/prototypes/T-1/flow.html",
  );
  expect(read.bytes.equals(html)).toBe(true);
  for (const escape of [
    "docs/screenshots/T-1/page.html",
    "index.html",
    "docs/prototypes/../x.html",
  ]) {
    await expect(
      readNodeTicketArtifact(node.runtime, card, "prototype", { live: true }, escape),
    ).rejects.toThrow(`prototype not found: live ${escape}`);
  }
});

/** The git commands the node runs, executed against the test repo standing in for the worktree. */
function realGit(argv: string[]): string {
  const [binary, ...args] = argv.map((arg) => (arg === "/wt/card-1" ? repo : arg));
  return execFileSync(binary!, args, { encoding: "utf8" });
}

/** A running card whose worktree repo holds an inherited, a committed, an edited, an untracked, and an ignored prototype. */
function runningPrototypeWorktree() {
  const inherited = "docs/prototypes/PROTO-1/old.html";
  const edited = "docs/prototypes/PROTO-1/edited.html";
  const base = commit({ "README.md": "base", [inherited]: "<p>old</p>", [edited]: "<p>v1</p>" });
  commit({ "docs/prototypes/T-1/committed.html": "<p>committed</p>" });
  fs.writeFileSync(path.join(repo, edited), "<p>v2</p>");
  fs.writeFileSync(path.join(repo, "docs/prototypes/T-1/untracked.html"), "<p>new</p>");
  fs.writeFileSync(path.join(repo, ".gitignore"), "ignored.html\n");
  fs.writeFileSync(path.join(repo, "docs/prototypes/T-1/ignored.html"), "<p>ignored</p>");
  const files = Object.fromEntries(
    [
      inherited,
      edited,
      "docs/prototypes/T-1/committed.html",
      "docs/prototypes/T-1/untracked.html",
      "docs/prototypes/T-1/ignored.html",
    ].map((name, index): [string, FakeNodeFile] => [
      `/wt/card-1/${name}`,
      { bytes: fs.readFileSync(path.join(repo, name)), mtime: index + 1 },
    ]),
  );
  return {
    node: fakeNode(files, () => true, realGit),
    card: nodeCard([], { baseCommit: base }),
    inherited,
  };
}

it("lists only the prototypes the running round changed, not those the base branch carries", async () => {
  const { node, card } = runningPrototypeWorktree();

  const listed = await listNodeTicketArtifacts(node.runtime, card, "prototype", { live: true });

  expect(listed.live).toMatchObject({ state: "available" });
  expect(
    listed.live?.state === "available" ? listed.live.files.map((file) => file.path).toSorted() : [],
  ).toEqual([
    "docs/prototypes/PROTO-1/edited.html",
    "docs/prototypes/T-1/committed.html",
    "docs/prototypes/T-1/untracked.html",
  ]);
});

it("refuses a live read of a file the base branch already had", async () => {
  const { node, card, inherited } = runningPrototypeWorktree();

  await expect(
    readNodeTicketArtifact(node.runtime, card, "prototype", { live: true }, inherited),
  ).rejects.toThrow(`prototype not found: live ${inherited}`);
  const read = await readNodeTicketArtifact(
    node.runtime,
    card,
    "prototype",
    { live: true },
    "docs/prototypes/T-1/untracked.html",
  );
  expect(read.bytes.toString()).toBe("<p>new</p>");
});

it("reports live unavailable, naming system.run, when the node's git fails", async () => {
  const node = fakeNode(
    {},
    () => true,
    () => {
      throw new Error("git: not a repository");
    },
  );

  const listed = await listScreenshots(node.runtime, nodeCard([], running), { live: true });

  expect(listed.live).toEqual({
    state: "unavailable",
    reason: expect.stringContaining("system.run"),
  });
});

it("refuses a round start that is not a commit id before running git on the node", async () => {
  const node = fakeNode(
    {},
    () => true,
    () => {
      throw new Error("git must not run");
    },
  );

  const listed = await listScreenshots(
    node.runtime,
    nodeCard([], { ...running, baseCommit: "-x" }),
    {
      live: true,
    },
  );

  expect(listed.live).toEqual({
    state: "unavailable",
    reason: expect.stringContaining("is not a commit id"),
  });
});

function linkedCard(id: string, title: string, rounds: WorkboardNodeRound[]) {
  return nodeCard(rounds, { id, title });
}

const relates = (targetCardId: string): WorkboardLink => ({
  id: `link-${targetCardId}`,
  type: "relates_to",
  createdAt: 0,
  targetCardId,
});

it("lists the committed files of cards linked with relates_to, in link order", async () => {
  const base = commit({ "README.md": "base" });
  const first = commit({ "docs/screenshots/PROTO-1/a.png": Buffer.from([1]) });
  const second = commit({ "docs/screenshots/PROTO-2/b.png": Buffer.from([2]) });
  const proto1 = linkedCard("p1", "Proto one", [{ round: 0, changes: changes(base, first) }]);
  const proto2 = linkedCard("p2", "Proto two", [{ round: 0, changes: changes(first, second) }]);
  const empty = linkedCard("p3", "Nothing", []);
  const card = nodeCard([], {
    links: [
      relates("p2"),
      relates("p1"),
      relates("p2"),
      relates("card-1"),
      relates("gone"),
      { id: "l", type: "parent", createdAt: 0, targetCardId: "p3" },
      { id: "m", type: "blocked_by", createdAt: 0, targetCardId: "p3" },
      { id: "n", type: "blocks", createdAt: 0, targetCardId: "p3" },
      { id: "o", type: "relates_to", createdAt: 0, url: "https://example.com" },
    ],
  });

  expect(relatedCardIds(card)).toEqual(["p2", "p1", "gone"]);
  const listed = await listScreenshots(noNode, card, {
    ...COMMITTED,
    linked: [proto2, proto1, empty],
  });

  expect(listed).toEqual({
    committed: { state: "available", rounds: [] },
    linked: [
      {
        cardId: "p2",
        title: "Proto two",
        committed: {
          state: "available",
          rounds: [{ round: 0, commit: second, paths: ["docs/screenshots/PROTO-2/b.png"] }],
        },
      },
      {
        cardId: "p1",
        title: "Proto one",
        committed: {
          state: "available",
          rounds: [{ round: 0, commit: first, paths: ["docs/screenshots/PROTO-1/a.png"] }],
        },
      },
    ],
  });
  expect(
    await readScreenshot(noNode, proto1, { round: 0 }, "docs/screenshots/PROTO-1/a.png"),
  ).toEqual({ mimeType: "image/png", contentBase64: Buffer.from([1]).toString("base64") });
});
