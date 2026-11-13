// Workboard tests cover node tickets' review previews: up on review, torn down on leaving it.
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import type { WorkboardCard, WorkboardPreviewSettings } from "@openclaw/workboard-contract";
import {
  closeOpenClawStateDatabaseAsync,
  writeSecretStoreEntryForTest,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { redactOperatorCard } from "./card-redaction.js";
import { syncWorkboardAgentEnded } from "./lifecycle-sync.js";
import { createNodePreviews } from "./node-ticket-preview.js";
import type { WorkboardNodeTicketRuntime } from "./node-ticket.js";
import {
  doneReport,
  endedSession,
  finishNodeTicket,
  git,
  postVerdict,
  removeTempRoots,
  startNodeCard,
} from "./node-ticket.test-support.js";
import type { WorkboardStore } from "./store.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";

const stateDirs: string[] = [];

afterEach(async () => {
  removeTempRoots();
  vi.unstubAllEnvs();
  await closeOpenClawStateDatabaseAsync();
  for (const dir of stateDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Points the Gateway's state at a fresh directory, so previews resolve store
 * SecretRefs from its secret store; returns a writer for that store.
 */
function isolatedSecretStore() {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "workboard-preview-state-"));
  stateDirs.push(stateDir);
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  return async (name: string, value: string) => {
    await writeSecretStoreEntryForTest({
      scope: { kind: "team" },
      name,
      value,
      kind: "secret",
      updatedBy: "workboard-preview-test",
      database: { env: { OPENCLAW_STATE_DIR: stateDir } },
    });
  };
}

const PREVIEW: WorkboardPreviewSettings = {
  up: ["sh", "-c", "echo {port} {card} > preview-up.txt"],
  down: ["sh", "-c", "echo {port} > ../preview-down-{card}.txt"],
  ports: { from: 48600, to: 48619 },
};

const DNS_NAME = "app-node.tail1234.ts.net";

// Run without a shell: a node drops all but locale variables from a shell wrapper's env.
const WRITE_TOKEN =
  "require('node:fs').writeFileSync('preview-token.txt', process.env.PREVIEW_TOKEN ?? '')";

type NodeCall = { argv: string[]; cwd?: string; env?: Record<string, string> };

/**
 * The local node gateway with `tailscale` answered as a node would: `serve`
 * succeeds unless `failServe`, `status` reports the node's MagicDNS name.
 */
function withTailscale(local: WorkboardNodeTicketRuntime, options: { failServe?: boolean } = {}) {
  const calls: NodeCall[] = [];
  const request: WorkboardNodeTicketRuntime["request"] = async <T>(
    method: string,
    params?: Record<string, unknown>,
  ) => {
    const nodeParams = params?.params as
      | { command?: string[]; cwd?: string; env?: Record<string, string> }
      | undefined;
    const argv = nodeParams?.command ?? [];
    calls.push({
      argv,
      ...(nodeParams?.cwd ? { cwd: nodeParams.cwd } : {}),
      ...(nodeParams?.env ? { env: nodeParams.env } : {}),
    });
    if (argv[0] !== "tailscale") {
      return await local.request<T>(method, params);
    }
    if (argv[1] === "status") {
      return {
        payload: { success: true, stdout: JSON.stringify({ Self: { DNSName: `${DNS_NAME}.` } }) },
      } as T;
    }
    return (
      options.failServe && argv.includes("--bg")
        ? { payload: { success: false, stderr: "Access denied: serve config denied" } }
        : { payload: { success: true, stdout: "" } }
    ) as T;
  };
  return { calls, request };
}

async function previewInReview(
  options: {
    preview?: WorkboardPreviewSettings;
    failServe?: boolean;
    symlinkedRoot?: boolean;
  } = {},
) {
  const ticket = await finishNodeTicket({});
  if (options.symlinkedRoot) {
    // The worktrees root is reached through a symlink, so git records the preview worktree under its real path.
    const { worktreesRoot } = ticket.repos.target;
    renameSync(worktreesRoot, `${worktreesRoot}-real`);
    symlinkSync(`${worktreesRoot}-real`, worktreesRoot);
  }
  await ticket.handoffs.resume(ticket.warn);
  const imported = await ticket.store.get(ticket.card.id);
  expect(imported?.status).toBe("review");
  await ticket.store.upsertBoard(
    { id: "default", orchestration: { preview: options.preview ?? PREVIEW } },
    { admin: true },
  );
  const node = withTailscale(ticket.gateway, options);
  const warn = vi.fn();
  const sync = createNodePreviews({
    store: ticket.store,
    runtime: node,
    config: () => ({}),
    now: Date.now,
  });
  const previewPath = path.join(ticket.repos.target.worktreesRoot, `wb-${ticket.card.id}-preview`);
  const handoff = imported?.metadata?.automation?.target?.worktree?.handoff;
  const headCommit = handoff?.phase === "imported" ? handoff.headCommit : "";
  return { ...ticket, node, warn, sync, previewPath, headCommit };
}

async function previewOf(store: WorkboardStore, cardId: string) {
  return (await store.get(cardId))?.metadata?.automation?.target?.worktree?.preview;
}

const card8 = (card: WorkboardCard) => card.id.slice(0, 8);

/** A second ticket on the same node and board, imported into review like the first. */
async function secondTicketInReview(ticket: Awaited<ReturnType<typeof previewInReview>>) {
  const { store, gateway, repos, handoffs } = ticket;
  const { card, sessionKey, runId } = await startNodeCard(store, gateway, repos.target);
  const worktree = path.join(repos.target.worktreesRoot, `wb-${card.id}`);
  writeFileSync(path.join(worktree, "lexer.py"), "ok\n");
  git(worktree, "add", "-A");
  git(worktree, "commit", "-q", "-m", "fix lexer");
  await syncWorkboardAgentEnded({
    store,
    event: { runId, success: true, messages: doneReport },
    context: { runId, sessionKey },
    readSessions: endedSession(),
  });
  await handoffs.resume(ticket.warn);
  expect((await store.get(card.id))?.status).toBe("review");
  return card;
}

describe("node ticket review previews", () => {
  it("starts the board's stack at the imported head on entering review and serves it on the tailnet", async () => {
    const { store, card, node, warn, sync, previewPath, headCommit } = await previewInReview();

    await sync(warn);

    expect(warn).not.toHaveBeenCalled();
    expect(git(previewPath, "rev-parse", "HEAD")).toBe(headCommit);
    expect(readFileSync(path.join(previewPath, "preview-up.txt"), "utf8")).toBe(
      `48600 ${card8(card)}\n`,
    );
    expect(node.calls).toContainEqual({
      argv: ["sh", "-c", `echo 48600 ${card8(card)} > preview-up.txt`],
      cwd: previewPath,
    });
    expect(node.calls).toContainEqual({
      argv: ["tailscale", "serve", "--bg", "--https=48600", "http://127.0.0.1:48600"],
    });
    expect(await previewOf(store, card.id)).toMatchObject({
      state: "up",
      headCommit,
      nodeId: "mac-factory",
      path: previewPath,
      port: 48600,
      url: `https://${DNS_NAME}:48600`,
      down: ["sh", "-c", `echo 48600 > ../preview-down-${card8(card)}.txt`],
    });
    const stored = expectDefined(await store.get(card.id), "card");
    expect(stored.status).toBe("review");
    expect(redactOperatorCard(stored).preview).toEqual(await previewOf(store, card.id));

    node.calls.length = 0;
    await sync(warn);
    expect(node.calls).toEqual([]);
  });

  it.each([
    [
      "accepted",
      async (store: WorkboardStore, id: string) => {
        await postVerdict(store, id);
        await store.move(id, "done", undefined);
      },
    ],
    [
      "sent back for rework",
      async (store: WorkboardStore, id: string) => {
        await postVerdict(store, id, "Verdict: rework: wrong flag");
        await store.move(id, "todo", undefined);
      },
    ],
    ["archived", async (store: WorkboardStore, id: string) => void (await store.archive(id, true))],
  ])("tears the preview down once the card is %s", async (_name, leave) => {
    const { store, card, repos, node, warn, sync, previewPath } = await previewInReview();
    await sync(warn);

    await leave(store, card.id);
    node.calls.length = 0;
    await sync(warn);

    expect(warn).not.toHaveBeenCalled();
    expect(node.calls.map((call) => call.argv)).toContainEqual([
      "tailscale",
      "serve",
      "--https=48600",
      "off",
    ]);
    expect(
      readFileSync(
        path.join(repos.target.worktreesRoot, `preview-down-${card8(card)}.txt`),
        "utf8",
      ),
    ).toBe("48600\n");
    expect(existsSync(previewPath)).toBe(false);
    expect(await previewOf(store, card.id)).toBeUndefined();
  });

  it("restarts the preview at the new head when the reviewed head changes", async () => {
    const { store, card, repos, node, warn, sync, previewPath, headCommit } =
      await previewInReview();
    await sync(warn);
    const nextHead = git(
      repos.target.repoPath,
      "commit-tree",
      `${headCommit}^{tree}`,
      "-p",
      headCommit,
      "-m",
      "next round",
    );
    const worktree = (await store.get(card.id))?.metadata?.automation?.target?.worktree;
    const handoff = worktree?.handoff;
    expect(handoff?.phase).toBe("imported");
    await store.setNodeHandoff(card.id, {
      worktreePath: worktree?.path ?? "",
      handoff: handoff?.phase === "imported" ? { ...handoff, headCommit: nextHead } : undefined,
    });

    node.calls.length = 0;
    await sync(warn);

    expect(warn).not.toHaveBeenCalled();
    expect(node.calls.map((call) => call.argv)).toContainEqual([
      "tailscale",
      "serve",
      "--https=48600",
      "off",
    ]);
    expect(
      existsSync(path.join(repos.target.worktreesRoot, `preview-down-${card8(card)}.txt`)),
    ).toBe(true);
    expect(git(previewPath, "rev-parse", "HEAD")).toBe(nextHead);
    expect(await previewOf(store, card.id)).toMatchObject({
      state: "up",
      headCommit: nextHead,
      port: 48600,
    });
  });

  it("gives two previews on one node different ports, and records a full range without starting anything", async () => {
    const ticket = await previewInReview({
      preview: { ...PREVIEW, ports: { from: 48600, to: 48601 } },
    });
    const { store, card, warn, sync } = ticket;
    const second = await secondTicketInReview(ticket);

    await sync(warn);

    const portOf = async (id: string) => {
      const preview = await previewOf(store, id);
      return preview?.state === "up" ? preview.port : undefined;
    };
    const ports = [await portOf(card.id), await portOf(second.id)];
    expect(ports.toSorted((left = 0, right = 0) => left - right)).toEqual([48600, 48601]);

    // The card on 48601 leaves; the one on 48600 keeps it under a one-port range.
    const [holder, leaving] = ports[0] === 48600 ? [card, second] : [second, card];
    await store.archive(leaving.id, true);
    await store.upsertBoard({
      id: "default",
      orchestration: { preview: { ...PREVIEW, ports: { from: 48600, to: 48600 } } },
    });
    await sync(warn);
    expect(await previewOf(store, leaving.id)).toBeUndefined();
    const third = await secondTicketInReview(ticket);
    const held = await previewOf(store, holder.id);
    ticket.node.calls.length = 0;
    await sync(warn);

    expect(warn).not.toHaveBeenCalled();
    expect(await previewOf(store, holder.id)).toEqual(held);
    expect(await previewOf(store, third.id)).toEqual({
      headCommit: expect.any(String),
      nodeId: "mac-factory",
      path: path.join(ticket.repos.target.worktreesRoot, `wb-${third.id}-preview`),
      down: [],
      state: "failed",
      error: "No preview port free on mac-factory: 1 previews running.",
      at: expect.any(Number),
    });
    expect(ticket.node.calls).toEqual([]);
  });

  it("keeps a failed start without retrying until the operator's Retry tears it down and starts again", async () => {
    const { store, card, repos, node, warn, sync, previewPath } = await previewInReview({
      failServe: true,
    });
    await sync(warn);

    expect(await previewOf(store, card.id)).toMatchObject({
      state: "failed",
      port: 48600,
      error: expect.stringMatching(
        /^tailscale serve failed on mac-factory: .*serve config denied\. Run `sudo tailscale set --operator=<node user>`/,
      ),
    });

    node.calls.length = 0;
    await sync(warn);
    expect(node.calls).toEqual([]);

    await store.retryNodePreview(card.id);
    expect(await previewOf(store, card.id)).toMatchObject({ state: "starting", port: 48600 });
    await sync(warn);

    expect(
      existsSync(path.join(repos.target.worktreesRoot, `preview-down-${card8(card)}.txt`)),
    ).toBe(true);
    expect(node.calls).toContainEqual({
      argv: ["sh", "-c", `echo 48600 ${card8(card)} > preview-up.txt`],
      cwd: previewPath,
    });
    expect(await previewOf(store, card.id)).toMatchObject({ state: "failed", port: 48600 });
  });

  it("refuses Retry on a preview that has not failed", async () => {
    const { store, card, warn, sync } = await previewInReview();
    await sync(warn);
    await expect(store.retryNodePreview(card.id)).rejects.toThrow(
      "only a failed review preview can be retried.",
    );
  });

  it("restarts a preview whose start a Gateway restart cut off", async () => {
    const { store, card, node, warn, sync, previewPath } = await previewInReview();
    await sync(warn);
    const worktree = (await store.get(card.id))?.metadata?.automation?.target?.worktree;
    const up = worktree?.preview;
    if (up?.state !== "up") {
      throw new Error("the preview did not come up");
    }
    const { url: _url, ...cutOff } = up;
    await store.setNodePreview(card.id, {
      worktreePath: worktree?.path ?? "",
      expectedAt: up?.at,
      preview: { ...cutOff, state: "starting", at: cutOff.at + 1 },
    });

    const restarted = createNodePreviews({
      store,
      runtime: node,
      config: () => ({}),
      now: Date.now,
    });
    node.calls.length = 0;
    await restarted(warn);

    expect(warn).not.toHaveBeenCalled();
    expect(node.calls.map((call) => call.argv)).toContainEqual([
      "tailscale",
      "serve",
      "--https=48600",
      "off",
    ]);
    expect(node.calls).toContainEqual({
      argv: ["sh", "-c", `echo 48600 ${card8(card)} > preview-up.txt`],
      cwd: previewPath,
    });
    expect(await previewOf(store, card.id)).toMatchObject({ state: "up", port: 48600 });
  });

  it("stops and removes a preview whose worktrees root is a symlink", async () => {
    const { store, card, repos, warn, sync, previewPath } = await previewInReview({
      symlinkedRoot: true,
    });
    await sync(warn);
    expect(await previewOf(store, card.id)).toMatchObject({ state: "up", path: previewPath });

    await store.archive(card.id, true);
    await sync(warn);

    expect(warn).not.toHaveBeenCalled();
    expect(
      readFileSync(
        path.join(repos.target.worktreesRoot, `preview-down-${card8(card)}.txt`),
        "utf8",
      ),
    ).toBe("48600\n");
    expect(existsSync(previewPath)).toBe(false);
    expect(await previewOf(store, card.id)).toBeUndefined();
  });

  it("runs one start per card when passes overlap, and leaves a running up alone", async () => {
    const { store, card, node, warn } = await previewInReview();
    let enterUp = () => {};
    const upEntered = new Promise<void>((resolve) => {
      enterUp = resolve;
    });
    let releaseUp = () => {};
    const upReleased = new Promise<void>((resolve) => {
      releaseUp = resolve;
    });
    let upHeld = false;
    const held: WorkboardNodeTicketRuntime = {
      request: async (method, params) => {
        const argv = (params?.params as { command?: string[] } | undefined)?.command ?? [];
        // Only the first `up` waits, so a wrongly restarted preview fails the assertions rather than hanging.
        if (argv.join(" ").includes("preview-up.txt") && !upHeld) {
          upHeld = true;
          enterUp();
          await upReleased;
        }
        return await node.request(method, params);
      },
    };
    // Both passes list the card before either reads its board.
    let listed = 0;
    const list = store.list.bind(store);
    vi.spyOn(store, "list").mockImplementation(async (options) => {
      const cards = await list(options);
      listed += 1;
      return cards;
    });
    let releaseBoard = () => {};
    const boardReleased = new Promise<void>((resolve) => {
      releaseBoard = resolve;
    });
    const boardOrchestration = store.boardOrchestration.bind(store);
    vi.spyOn(store, "boardOrchestration").mockImplementation(async (boardId) => {
      await boardReleased;
      return await boardOrchestration(boardId);
    });
    const overlapping = createNodePreviews({
      store,
      runtime: held,
      config: () => ({}),
      now: Date.now,
    });

    const first = overlapping(warn);
    const second = overlapping(warn);
    await vi.waitFor(() => expect(listed).toBe(2));
    releaseBoard();
    await upEntered;
    // The pass that did not get the card has settled; the other's `up` still runs.
    await Promise.race([first, second]);
    await overlapping(warn);
    releaseUp();
    await Promise.all([first, second]);

    expect(warn).not.toHaveBeenCalled();
    const argvs = node.calls.map((call) => call.argv.join(" "));
    expect(argvs.filter((argv) => argv.includes("preview-up.txt"))).toHaveLength(1);
    expect(argvs.filter((argv) => argv.endsWith(" off"))).toEqual([]);
    expect(await previewOf(store, card.id)).toMatchObject({ state: "up", port: 48600 });
  });

  it("keeps a teardown that ran while a rework launch fetched", async () => {
    const { store, card, repos, gateway, github, handoffs, warn, sync } = await previewInReview();
    await sync(warn);
    await postVerdict(store, card.id, "Verdict: rework: wrong flag");
    git(repos.hostRepo, "remote", "set-url", "origin", "git@github.com:acme/app.git");
    github.tokens.set("acme/app", "token-app");
    github.openPulls.push("https://github.com/acme/app/pull/7");
    await store.addComment(card.id, { body: "Rename the flag." });
    const request = gateway.request.bind(gateway);
    let tornDown = false;
    vi.spyOn(gateway, "request").mockImplementation(async (method, params) => {
      const argv = (params?.params as { command?: string[] } | undefined)?.command ?? [];
      if (!tornDown && argv.includes("fetch") && argv.includes("--prune")) {
        tornDown = true;
        await sync(warn);
        expect(await previewOf(store, card.id)).toBeUndefined();
      }
      return await request(method, params);
    });

    await store.move(card.id, "todo", undefined);
    await handoffs.resume(warn);
    await handoffs.resume(warn);

    expect(warn).not.toHaveBeenCalled();
    expect(tornDown).toBe(true);
    expect((await store.get(card.id))?.status).toBe("running");
    expect(await previewOf(store, card.id)).toBeUndefined();
  });

  it("names the failed command and keeps the end of a verbose up's error", async () => {
    const { store, card, warn, sync } = await previewInReview({
      preview: {
        ...PREVIEW,
        up: ["sh", "-c", "head -c 2000 /dev/zero | tr '\\0' x >&2; echo ' disk full' >&2; exit 1"],
      },
    });
    await sync(warn);

    const preview = await previewOf(store, card.id);
    expect(preview?.state).toBe("failed");
    expect(preview?.state === "failed" ? preview.error : "").toMatch(
      /^The board's preview up failed on mac-factory: node mac-factory failed `sh -c head -c 2000.*…x+ disk full\. Fix the stack/,
    );
  });

  it("resolves the board's store secrets at each start and passes them to up alone, recording no value", async () => {
    const tokenRef = { source: "store", provider: "default", id: "WB_PREVIEW_TEST_TOKEN" } as const;
    const preview: WorkboardPreviewSettings = {
      ...PREVIEW,
      up: [process.execPath, "-e", WRITE_TOKEN],
      env: { PREVIEW_TOKEN: tokenRef },
    };
    const { store, card, node, warn, sync, previewPath } = await previewInReview({ preview });
    const storeSecret = isolatedSecretStore();
    await sync(warn);

    const unresolved = await previewOf(store, card.id);
    expect(unresolved?.state === "failed" ? unresolved.error : "").toMatch(
      /^Preview secret PREVIEW_TOKEN could not be resolved: .*Store it with `openclaw secrets store set WB_PREVIEW_TEST_TOKEN`, then Retry\.$/,
    );
    expect(node.calls.some((call) => call.argv[0] === process.execPath)).toBe(false);

    // Retry starts the first value; archiving tears it down, unarchiving starts the rotated one.
    const restarts = [
      ["first-secret-value", () => store.retryNodePreview(card.id)],
      ["rotated-secret-value", () => store.archive(card.id, false)],
    ] as const;
    for (const [secret, restart] of restarts) {
      await storeSecret(tokenRef.id, secret);
      await restart();
      node.calls.length = 0;
      await sync(warn);
      expect(readFileSync(path.join(previewPath, "preview-token.txt"), "utf8")).toBe(secret);
      expect(node.calls.filter((call) => call.env)).toEqual([
        { argv: preview.up, cwd: previewPath, env: { PREVIEW_TOKEN: secret } },
      ]);
      expect(await previewOf(store, card.id)).toMatchObject({ state: "up" });

      await store.archive(card.id, true);
      node.calls.length = 0;
      await sync(warn);
      expect(await previewOf(store, card.id)).toBeUndefined();
      expect(node.calls.filter((call) => call.env)).toEqual([]);
    }

    expect(warn).not.toHaveBeenCalled();
    const boards = JSON.stringify((await store.listBoards()).boards);
    expect(boards).toContain('"WB_PREVIEW_TEST_TOKEN"');
    for (const recorded of [JSON.stringify(await store.get(card.id)), boards]) {
      expect(recorded).not.toContain("secret-value");
    }
  });

  it("passes the board's project env to up beneath its preview secrets", async () => {
    const tokenRef = { source: "store", provider: "default", id: "WB_PREVIEW_TEST_TOKEN" } as const;
    const preview: WorkboardPreviewSettings = {
      ...PREVIEW,
      up: [process.execPath, "-e", WRITE_TOKEN],
      env: { PREVIEW_TOKEN: tokenRef },
    };
    const { store, node, warn, sync, previewPath } = await previewInReview({ preview });
    await isolatedSecretStore()(tokenRef.id, "store-value");
    const env = { PROJECT_URL: "http://192.0.2.7:11434", PREVIEW_TOKEN: "board-value" };
    // up holds the secrets, so only an admin may change what else it receives.
    await expect(store.upsertBoard({ id: "default", orchestration: { env } })).rejects.toThrow(
      "needs operator.admin",
    );
    await store.upsertBoard({ id: "default", orchestration: { env } }, { admin: true });
    await sync(warn);

    expect(readFileSync(path.join(previewPath, "preview-token.txt"), "utf8")).toBe("store-value");
    expect(node.calls.filter((call) => call.env)).toEqual([
      {
        argv: preview.up,
        cwd: previewPath,
        env: { PROJECT_URL: "http://192.0.2.7:11434", PREVIEW_TOKEN: "store-value" },
      },
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("passes the board's project env to up on a board without preview secrets", async () => {
    const { store, node, warn, sync, previewPath } = await previewInReview();
    await store.upsertBoard({
      id: "default",
      orchestration: { env: { PROJECT_URL: "http://192.0.2.7:11434" } },
    });
    await sync(warn);

    expect(node.calls.filter((call) => call.env)).toMatchObject([
      { cwd: previewPath, env: { PROJECT_URL: "http://192.0.2.7:11434" } },
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("cuts every resolved value out of a failed up's recorded error, longest first", async () => {
    const storeSecret = isolatedSecretStore();
    // The short value is the long one's prefix, so cutting it first would leave the long one's tail.
    await storeSecret("WB_PREVIEW_SHORT", "leaky-secret");
    await storeSecret("WB_PREVIEW_LONG", "leaky-secret-and-its-tail");
    const { store, card, warn, sync } = await previewInReview({
      preview: {
        ...PREVIEW,
        up: [
          process.execPath,
          "-e",
          "process.stderr.write(`echoed ${process.env.PREVIEW_SHORT} ${process.env.PREVIEW_LONG}`); process.exit(1)",
        ],
        env: {
          PREVIEW_SHORT: { source: "store", provider: "default", id: "WB_PREVIEW_SHORT" },
          PREVIEW_LONG: { source: "store", provider: "default", id: "WB_PREVIEW_LONG" },
        },
      },
    });
    await sync(warn);

    const preview = await previewOf(store, card.id);
    expect(preview?.state === "failed" ? preview.error : "").toMatch(
      /: echoed \[redacted\] \[redacted\]\. Fix the stack/,
    );
    expect(JSON.stringify(await store.get(card.id))).not.toMatch(/leaky|its-tail/);
  });

  it("starts nothing on a board without previews", async () => {
    const { store, card, node, warn } = await previewInReview();
    await store.upsertBoard({ id: "default", orchestration: { preview: null } });
    await createNodePreviews({ store, runtime: node, config: () => ({}), now: Date.now })(warn);
    expect(node.calls).toEqual([]);
    expect(await previewOf(store, card.id)).toBeUndefined();
  });
});

const STORE_REF = { source: "store", provider: "default", id: "LINDRA_PREVIEW_TOKEN" } as const;

describe("board project env", () => {
  it("stores, keeps, validates, and clears a board's project env", async () => {
    const store = createWorkboardSqliteTestStore();
    const env = async () =>
      (await store.listBoards()).boards.find((board) => board.id === "app")?.orchestration?.env;
    await store.upsertBoard({ id: "app", orchestration: { env: { MODEL_URL: "http://x:1" } } });
    await store.upsertBoard({ id: "app", orchestration: { autoDecompose: true } });
    await expect(env()).resolves.toEqual({ MODEL_URL: "http://x:1" });
    for (const [input, error] of [
      [{ "model-url": "x" }, 'env name "model-url" must be'],
      [JSON.parse('{"__proto__": "x"}'), 'env name "__proto__" must be'],
      [{ MODEL_URL: "a\nb" }, "env MODEL_URL must be one line"],
      [{ MODEL_URL: "x".repeat(1001) }, "env MODEL_URL must be one line"],
      [{ MODEL_URL: STORE_REF }, "a credential belongs in preview.env"],
      [Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`V${i}`, "x"])), "at most 32"],
    ] as const) {
      await expect(store.upsertBoard({ id: "app", orchestration: { env: input } })).rejects.toThrow(
        error,
      );
    }
    await expect(env()).resolves.toEqual({ MODEL_URL: "http://x:1" });
    await store.upsertBoard({ id: "app", orchestration: { env: null } });
    await expect(env()).resolves.toBeUndefined();
  });
});

describe("board preview settings", () => {
  it("stores, carries, validates, and clears a board's preview", async () => {
    const store = createWorkboardSqliteTestStore();
    const preview = async () =>
      (await store.listBoards()).boards.find((board) => board.id === "app")?.orchestration?.preview;
    const withEnv = { ...PREVIEW, env: { LINDRA_PREVIEW_TOKEN: STORE_REF } };
    const admin = { admin: true };
    await store.upsertBoard({ id: "app", orchestration: { preview: withEnv } }, admin);
    await store.upsertBoard({ id: "app", orchestration: { autoDecompose: true } });
    await expect(preview()).resolves.toEqual(withEnv);
    await store.upsertBoard(
      { id: "app", orchestration: { preview: { ...PREVIEW, env: {} } } },
      admin,
    );
    await expect(preview()).resolves.toEqual(PREVIEW);
    await store.upsertBoard({ id: "app", orchestration: { preview: PREVIEW } });
    for (const [input, error] of [
      [{ ...PREVIEW, up: [] }, "preview up must be an argv"],
      [{ ...PREVIEW, down: ["sh", 3] }, "preview down must be an argv"],
      [{ ...PREVIEW, ports: { from: 80, to: 90 } }, "preview ports must be integers"],
      [{ ...PREVIEW, ports: { from: 48619, to: 48600 } }, "with from <= to"],
      [{ ...PREVIEW, ports: { from: 48600.5, to: 48610 } }, "preview ports must be integers"],
      [{ up: PREVIEW.up, down: PREVIEW.down }, "preview needs up, down, and ports"],
      [{ ...PREVIEW, env: { "1TOKEN": STORE_REF } }, 'preview env name "1TOKEN" must be'],
      [{ ...PREVIEW, env: { "MY-TOKEN": STORE_REF } }, 'preview env name "MY-TOKEN" must be'],
      [{ ...PREVIEW, env: { token: STORE_REF } }, 'preview env name "token" must be'],
      [
        { ...PREVIEW, env: JSON.parse(`{"__proto__": ${JSON.stringify(STORE_REF)}}`) },
        'preview env name "__proto__" must be',
      ],
      [
        { ...PREVIEW, env: { TOKEN: "plain-value" } },
        "preview env TOKEN must be a store SecretRef",
      ],
      [
        { ...PREVIEW, env: { TOKEN: { ...STORE_REF, id: "lower-case" } } },
        "preview env TOKEN must be a store SecretRef",
      ],
      ...(["env", "file", "exec"] as const).map(
        (source) =>
          [
            {
              ...PREVIEW,
              env: { TOKEN: { source, provider: "default", id: "OPENCLAW_GATEWAY_TOKEN" } },
            },
            "preview env TOKEN must be a store SecretRef",
          ] as const,
      ),
      [
        {
          ...PREVIEW,
          env: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`T${i}`, STORE_REF])),
        },
        "preview env takes at most 32 variables",
      ],
    ] as const) {
      await expect(
        store.upsertBoard({ id: "app", orchestration: { preview: input } }, admin),
      ).rejects.toThrow(error);
    }
    await expect(preview()).resolves.toEqual(PREVIEW);
    await store.upsertBoard({ id: "app", orchestration: { preview: null } });
    await expect(preview()).resolves.toBeUndefined();
  });
});
