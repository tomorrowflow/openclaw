// Workboard tests cover the trust ladder's rung b: class rungs, agent acceptance, and the review sample.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import type {
  WorkboardCard,
  WorkboardClassRung,
  WorkboardExecutionTarget,
  WorkboardNodeVerification,
} from "@openclaw/workboard-contract";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../api.js";
import { registerWorkboardGatewayMethods } from "./gateway.js";
import { publishCandidate, publishNodeTicket } from "./node-ticket-publish.js";
import { nodeTicketAcceptance, nodeTicketTarget } from "./node-ticket.js";
import {
  createFakeGitHub,
  createNodeRepos,
  git,
  NODE_TARGET,
  startNodeCard,
} from "./node-ticket.test-support.js";
import type { WorkboardStore } from "./store.js";
import { createGatewayMethodCapture } from "./test/gateway-method-capture.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";
import { createWorkboardTools } from "./tools.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const VERDICT_FIRST = "Post `Verdict: accept` or `Verdict: rework: <finding>` as a comment first";

/**
 * A docs ticket launched under `classRungs` and imported as the bundle import
 * leaves it: handoff `imported`, claim released, waiting in review. `later`
 * replaces the board's rungs after the launch.
 */
async function importedDocsTicket(
  store: WorkboardStore,
  params: {
    classRungs?: Record<string, WorkboardClassRung>;
    later?: Record<string, WorkboardClassRung>;
    target?: WorkboardExecutionTarget;
    headCommit?: string;
  } = {},
) {
  if (params.classRungs) {
    await store.upsertBoard({ id: "default", orchestration: { classRungs: params.classRungs } });
  }
  const { card } = await startNodeCard(store, undefined, params.target, ["class:docs"]);
  const running = expectDefined(await store.get(card.id), "running card");
  const claim = expectDefined(running.metadata?.claim, "claim");
  const worktree = expectDefined(nodeTicketTarget(running)?.worktree, "worktree");
  await store.setNodeHandoff(
    card.id,
    {
      worktreePath: worktree.path,
      handoff: {
        phase: "imported",
        headCommit: params.headCommit ?? "b".repeat(40),
        importedAt: Date.now(),
      },
    },
    claim,
  );
  await store.releaseClaim(card.id, {
    ownerId: claim.ownerId,
    token: claim.token,
    status: "review",
  });
  if (params.later) {
    await store.upsertBoard({ id: "default", orchestration: { classRungs: params.later } });
  }
  return card;
}

function agentTools(store: WorkboardStore) {
  const tools = createWorkboardTools({ store, context: { agentId: "dev" } });
  return (name: string) =>
    expectDefined(
      tools.find((tool) => tool.name === name),
      name,
    );
}

const handoffOf = async (store: WorkboardStore, card: WorkboardCard) =>
  nodeTicketTarget(expectDefined(await store.get(card.id), "card"))?.worktree?.handoff;

function readPayload(result: unknown): Record<string, unknown> {
  return (result as { details?: Record<string, unknown> }).details ?? {};
}

describe("Workboard rung b", () => {
  it("keeps operator-set class rungs whole: replaced, cleared, refused when invalid, never agent-set", async () => {
    const store = createWorkboardSqliteTestStore();
    const rungs = async () =>
      (await store.listBoards()).boards.find((board) => board.id === "app")?.orchestration
        ?.classRungs;
    await store.upsertBoard({
      id: "app",
      orchestration: {
        classRungs: { docs: { rung: "b" }, security: { rung: "b", sampleEvery: 1 } },
      },
    });
    const boardCreate = expectDefined(
      createWorkboardTools({ store, context: { agentId: "dev" } }).find(
        (tool) => tool.name === "workboard_board_create",
      ),
      "board create tool",
    );
    expect(
      Value.Check(boardCreate.parameters, {
        id: "app",
        orchestration: { classRungs: { docs: { rung: "b" } } },
      }),
    ).toBe(false);
    await boardCreate.execute("call-board", { id: "app", orchestration: { autoDecompose: true } });
    await expect(rungs()).resolves.toEqual({
      docs: { rung: "b", since: expect.any(Number) },
      security: { rung: "b", sampleEvery: 1, since: expect.any(Number) },
    });

    await store.upsertBoard({ id: "app", orchestration: { classRungs: { docs: { rung: "a" } } } });
    await expect(rungs()).resolves.toEqual({ docs: { rung: "a", since: expect.any(Number) } });
    for (const [classRungs, error] of [
      [{ docs: { rung: "c" } }, "class rung docs needs rung a or b."],
      [
        { docs: { rung: "b", sampleEvery: 0 } },
        "class rung docs sampleEvery must be an integer from 1 to 100.",
      ],
      [
        { docs: { rung: "b", sampleEvery: 1.5 } },
        "class rung docs sampleEvery must be an integer from 1 to 100.",
      ],
      [
        { "class:docs": { rung: "b" } },
        "class rung class:docs must name the class without the class: prefix.",
      ],
      [
        { " docs": { rung: "b" } },
        "class rung names must be 1 to 34 characters without surrounding spaces.",
      ],
      [[{ rung: "b" }], "class rungs must be an object of at most 50 classes."],
      [
        Object.fromEntries(Array.from({ length: 51 }, (_, index) => [`c${index}`, { rung: "b" }])),
        "class rungs must be an object of at most 50 classes.",
      ],
      ...[-1, 1.5, Date.now() + 60_000].map(
        (since) =>
          [
            { docs: { rung: "b", since } },
            "class rung docs since must be an epoch ms integer from 0 to now.",
          ] as const,
      ),
    ] as const) {
      await expect(store.upsertBoard({ id: "app", orchestration: { classRungs } })).rejects.toThrow(
        error,
      );
    }
    await expect(rungs()).resolves.toEqual({ docs: { rung: "a", since: expect.any(Number) } });
    await store.upsertBoard({ id: "app", orchestration: { classRungs: null } });
    await expect(rungs()).resolves.toBeUndefined();
  });

  it("keeps the operator-set verifier whole: saved, carried, refused when invalid, cleared", async () => {
    const store = createWorkboardSqliteTestStore();
    const verifier = async () =>
      (await store.listBoards()).boards.find((board) => board.id === "app")?.orchestration
        ?.verifier;
    await store.upsertBoard({
      id: "app",
      orchestration: { verifier: { agentId: "verifier", model: "openai/gpt-6-sol" } },
    });
    await expect(verifier()).resolves.toEqual({ agentId: "verifier", model: "openai/gpt-6-sol" });
    await store.upsertBoard({ id: "app", orchestration: { autoDecompose: true } });
    await expect(verifier()).resolves.toEqual({ agentId: "verifier", model: "openai/gpt-6-sol" });
    for (const [input, error] of [
      [
        { agentId: "", model: "openai/gpt-6-sol" },
        "verifier needs a non-empty agentId and a model.",
      ],
      [{ agentId: "verifier" }, "verifier needs a non-empty agentId and a model."],
      ["verifier", "verifier needs a non-empty agentId and a model."],
      [
        { agentId: "verifier", model: "gpt-6-sol" },
        "verifier model gpt-6-sol must be provider/model.",
      ],
      [{ agentId: "verifier", model: "openai/ gpt" }, "must be provider/model."],
    ] as const) {
      await expect(
        store.upsertBoard({ id: "app", orchestration: { verifier: input } }),
      ).rejects.toThrow(error);
    }
    await expect(verifier()).resolves.toEqual({ agentId: "verifier", model: "openai/gpt-6-sol" });
    await store.upsertBoard({ id: "app", orchestration: { verifier: null } });
    await expect(verifier()).resolves.toBeUndefined();
  });

  it("stamps since when a class changes rung, carries it otherwise, and takes an explicit backfill", async () => {
    const store = createWorkboardSqliteTestStore();
    const save = async (classRungs: Record<string, unknown>) =>
      (await store.upsertBoard({ id: "app", orchestration: { classRungs } })).orchestration
        ?.classRungs;
    const before = Date.now();
    const first = await save({ docs: { rung: "b" }, ios: { rung: "a" } });
    const stamped = expectDefined(first?.docs?.since, "docs since");
    expect(stamped).toBeGreaterThanOrEqual(before);
    expect(stamped).toBeLessThanOrEqual(Date.now());
    // Listing an unlisted class at rung a is not a change.
    expect(first?.ios).toEqual({ rung: "a" });

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });
    expect(await save({ docs: { rung: "b", sampleEvery: 1 }, ios: { rung: "a" } })).toEqual({
      docs: { rung: "b", sampleEvery: 1, since: stamped },
      ios: { rung: "a" },
    });
    await store.upsertBoard({ id: "app", orchestration: { autoDecompose: true } });
    expect(await save({ docs: { rung: "b" } })).toEqual({ docs: { rung: "b", since: stamped } });

    const demoted = expectDefined((await save({ docs: { rung: "a" } }))?.docs?.since, "demoted");
    expect(demoted).toBeGreaterThan(stamped);
    expect(await save({ docs: { rung: "b", since: 1_000 } })).toEqual({
      docs: { rung: "b", since: 1_000 },
    });
    expect(await save({ docs: { rung: "b" } })).toEqual({ docs: { rung: "b", since: 1_000 } });
  });

  it("refuses an agent's acceptance at rung a through every tool that reaches done", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await importedDocsTicket(store);
    await store.addComment(card.id, { body: "Verdict: accept" }, undefined, "agent:dev");
    const tool = agentTools(store);
    const refusal = "Rung a: the operator accepts docs tickets.";

    await expect(
      tool("workboard_move").execute("move", { id: card.id, status: "done" }),
    ).rejects.toThrow(refusal);
    await expect(
      tool("workboard_release").execute("release", { id: card.id, status: "done" }),
    ).rejects.toThrow(refusal);
    const claimed = readPayload(await tool("workboard_claim").execute("claim", { id: card.id }));
    await expect(
      tool("workboard_complete").execute("complete", {
        id: card.id,
        token: claimed.token,
        summary: "Looks right",
      }),
    ).rejects.toThrow(refusal);

    expect((await store.get(card.id))?.status).not.toBe("done");
    await expect(handoffOf(store, card)).resolves.toEqual({
      phase: "imported",
      headCommit: "b".repeat(40),
      importedAt: expect.any(Number),
    });
  });

  it("refuses reopening an imported round before its draft PR exists, leaving it in review", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await importedDocsTicket(store);
    const refusal = "This ticket's latest round was imported but isn't published yet.";

    await expect(store.move(card.id, "todo", undefined)).rejects.toThrow(refusal);
    await expect(store.move(card.id, "ready", undefined)).rejects.toThrow(refusal);
    await expect(
      agentTools(store)("workboard_move").execute("move", { id: card.id, status: "todo" }),
    ).rejects.toThrow(refusal);

    expect((await store.get(card.id))?.status).toBe("review");
    await expect(handoffOf(store, card)).resolves.toEqual({
      phase: "imported",
      headCommit: "b".repeat(40),
      importedAt: expect.any(Number),
    });
  });

  it("refuses an agent's acceptance of a round that ran before its class reached rung b", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await importedDocsTicket(store, { later: { docs: { rung: "b" } } });
    await store.addComment(card.id, { body: "Verdict: accept" }, undefined, "agent:dev");

    await expect(
      agentTools(store)("workboard_move").execute("move", { id: card.id, status: "done" }),
    ).rejects.toThrow(
      "This round ran before its class reached rung b, so the operator accepts it.",
    );
  });

  it("gates an agent's rung b accept on a passed verification, never a rework verdict or an operator", async () => {
    const store = createWorkboardSqliteTestStore();
    await store.upsertBoard({
      id: "default",
      orchestration: { verifier: { agentId: "verifier", model: "openai/gpt-6-sol" } },
    });
    const card = await importedDocsTicket(store, { classRungs: { docs: { rung: "b" } } });
    const worktreePath = expectDefined(
      nodeTicketTarget(expectDefined(await store.get(card.id), "card"))?.worktree?.path,
      "worktree path",
    );
    const head = "b".repeat(40);
    const facts = { round: 0, headCommit: head, startedAt: 1, endedAt: 2, findings: [] };
    const verified = async (verification: WorkboardNodeVerification | undefined) =>
      verification
        ? await store.setNodeVerification(card.id, { worktreePath, verification })
        : undefined;
    await store.addComment(card.id, { body: "Verdict: accept" }, undefined, "agent:dev");
    const move = agentTools(store)("workboard_move");
    const accept = () => move.execute("accept", { id: card.id, status: "done" });

    await expect(accept()).rejects.toThrow("Verification is still running; wait for its comment.");
    await verified({
      phase: "running",
      round: 0,
      headCommit: head,
      startedAt: 1,
      sessionKey: "agent:verifier:verify-x-r0",
      path: "/wt/verify",
    });
    await expect(accept()).rejects.toThrow("Verification is still running; wait for its comment.");
    await verified({
      phase: "done",
      ...facts,
      verdict: "fail",
      summary: "pytest fails on empty input",
    });
    await expect(accept()).rejects.toThrow(
      "The verification failed: pytest fails on empty input. Post `Verdict: rework: …` and rework it.",
    );
    await verified({ phase: "done", ...facts, verdict: "error", summary: "no report block" });
    await expect(accept()).rejects.toThrow(
      "The verification could not finish (no report block). Leave the card in review; the operator decides or re-runs it.",
    );
    // A stale pass from another head gates like a missing one.
    await verified({
      phase: "done",
      ...facts,
      headCommit: "c".repeat(40),
      verdict: "pass",
      summary: "",
    });
    await expect(accept()).rejects.toThrow("Verification is still running; wait for its comment.");

    // A rework verdict is never gated: the agent moves the card on to publish the draft.
    await verified({ phase: "done", ...facts, verdict: "fail", summary: "broken" });
    await store.addComment(card.id, { body: "Verdict: rework: broken" }, undefined, "agent:dev");
    await accept();
    await expect(handoffOf(store, card)).resolves.toMatchObject({ decidedBy: "agent:dev" });
    await store.move(card.id, "review", undefined);

    await store.addComment(card.id, { body: "Verdict: accept" }, undefined, "agent:dev");
    await verified({ phase: "done", ...facts, verdict: "pass", summary: "pytest green" });
    await accept();
    await expect(handoffOf(store, card)).resolves.toMatchObject({
      decidedBy: "agent:dev",
      sampled: expect.any(Boolean),
    });

    // The operator is never gated.
    await store.move(card.id, "review", undefined);
    await verified({ phase: "done", ...facts, verdict: "fail", summary: "broken" });
    await store.move(card.id, "done", undefined);
    await expect(handoffOf(store, card)).resolves.toEqual({
      phase: "imported",
      headCommit: head,
      importedAt: expect.any(Number),
    });
  });

  it("lets an agent accept at rung b after its verdict, and an operator retry decides again", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await importedDocsTicket(store, {
      classRungs: { docs: { rung: "b", sampleEvery: 1 } },
    });
    const move = agentTools(store)("workboard_move");
    await expect(move.execute("early", { id: card.id, status: "done" })).rejects.toThrow(
      VERDICT_FIRST,
    );

    await store.addComment(card.id, { body: "Verdict: accept" }, undefined, "agent:dev");
    await move.execute("accept", { id: card.id, status: "done" });
    expect((await store.get(card.id))?.status).toBe("done");
    await expect(handoffOf(store, card)).resolves.toMatchObject({
      phase: "imported",
      decidedBy: "agent:dev",
      sampled: true,
    });

    // A failed publish blocks the card; the operator's move to done then decides it.
    await store.block(card.id, { reason: "Draft PR failed" }, null);
    const methods = new Map<string, Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1]>();
    registerWorkboardGatewayMethods({
      api: {
        runtime: {},
        registerGatewayMethod: (
          method: string,
          handler: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1],
        ) => methods.set(method, handler),
      } as unknown as OpenClawPluginApi,
      store,
    });
    const respond = vi.fn();
    await expectDefined(
      methods.get("workboard.cards.move"),
      "move method",
    )({
      params: { id: card.id, status: "done" },
      respond,
    } as never);
    expect(respond).toHaveBeenCalledWith(true, expect.anything());
    await expect(handoffOf(store, card)).resolves.toEqual({
      phase: "imported",
      headCommit: "b".repeat(40),
      importedAt: expect.any(Number),
    });
  });

  it("samples by the card: stable per card, every reworked round, and 1 in sampleEvery", () => {
    const accept = (id: string, classRung: WorkboardClassRung, round = 0) =>
      nodeTicketAcceptance({
        card: {
          id,
          title: id,
          status: "done",
          priority: "normal",
          labels: ["class:docs"],
          position: 0,
          createdAt: 0,
          updatedAt: 0,
          metadata: {
            comments: [{ id: "v", body: "Verdict: accept", createdAt: 1, source: "agent:dev" }],
          },
        },
        worktree: {
          path: "/wt",
          branch: `factory/${id}`,
          baseCommit: "a",
          rung: "b",
          ...(round > 0
            ? { rework: { round, pullRequestUrl: "u", acceptedAt: 0, outsideCommits: 0 } }
            : {}),
        },
        handoff: { phase: "imported", headCommit: "b", importedAt: 0 },
        actor: "agent:dev",
        board: { classRungs: { docs: classRung } },
      }).sampled;
    const ids = Array.from({ length: 300 }, (_, index) => `card-${index}`);
    const picks = ids.map((id) => accept(id, { rung: "b" }));

    expect(ids.map((id) => accept(id, { rung: "b" }))).toEqual(picks);
    const sampled = picks.filter(Boolean).length;
    expect(sampled).toBeGreaterThan(70);
    expect(sampled).toBeLessThan(130);
    const unsampled = expectDefined(ids[picks.indexOf(false)], "an unsampled card");
    expect(accept(unsampled, { rung: "b" }, 1)).toBe(true);
    expect(accept(unsampled, { rung: "b", sampleEvery: 1 })).toBe(true);
  });

  it("opens an agent-accepted PR ready for review with the sample and review lines, an operator's as a draft", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "workboard-rung-b-"));
    roots.push(root);
    const repos = createNodeRepos(root);
    git(repos.hostRepo, "remote", "set-url", "origin", "git@github.com:acme/app.git");
    const github = createFakeGitHub(repos.origin);
    github.tokens.set("acme/app", "token-app");
    const store = createWorkboardSqliteTestStore();
    const publish = async (decide: (card: WorkboardCard) => Promise<unknown>) => {
      const head = git(repos.hostRepo, "rev-parse", "HEAD");
      const card = await importedDocsTicket(store, {
        classRungs: { docs: { rung: "b", sampleEvery: 1 } },
        target: { ...NODE_TARGET, hostRepoPath: repos.hostRepo },
        headCommit: head,
      });
      git(repos.hostRepo, "branch", `factory/${card.id}`, head);
      await store.addProof(card.id, {
        status: "passed",
        label: "standards review",
        note: "2 findings, 2 fixed",
      });
      await store.addComment(card.id, { body: "Verdict: accept" }, undefined, "agent:dev");
      await decide(card);
      const item = expectDefined(
        publishCandidate(expectDefined(await store.get(card.id), "card")),
        "publish candidate",
      );
      await publishNodeTicket({ store, github: github.access, item, now: Date.now });
      return {
        opened: github.requests.findLast((request) => request.method === "POST")?.body as Record<
          string,
          unknown
        >,
        reviews: nodeTicketTarget(expectDefined(await store.get(card.id), "card"))?.worktree
          ?.reviews,
      };
    };

    const agent = await publish(
      async (card) =>
        await agentTools(store)("workboard_move").execute("accept", {
          id: card.id,
          status: "done",
        }),
    );
    expect(agent.opened).toMatchObject({ draft: false });
    expect(agent.opened.body).toContain(
      "Standards review: 2 findings, 2 fixed\n\nSampled for human review: a person reads this PR before it merges.",
    );
    expect(agent.reviews).toEqual([
      expect.objectContaining({ round: 0, verdict: "accept", decidedBy: "agent", sampled: true }),
    ]);

    const operator = await publish(async (card) => await store.move(card.id, "done", undefined));
    expect(operator.opened).toMatchObject({ draft: true });
    expect(operator.opened.body).not.toContain("Sampled");
    // The round ran at rung b, so the operator saw its verification: the KPIs do not score it.
    expect(operator.reviews).toEqual([
      {
        round: 0,
        verdict: "accept",
        importedAt: expect.any(Number),
        publishedAt: expect.any(Number),
        rung: "b",
      },
    ]);
    expect((await store.trust({ boardId: "default" })).classes).toEqual([
      expect.objectContaining({ taskClass: "docs", rung: "b", accepted: 2, agentAccepts: 1 }),
    ]);
  });

  it("marks the draft PR an earlier round opened ready when an agent accepts, an operator's stays a draft", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "workboard-rung-b-"));
    roots.push(root);
    const repos = createNodeRepos(root);
    git(repos.hostRepo, "remote", "set-url", "origin", "git@github.com:acme/app.git");
    const github = createFakeGitHub(repos.origin);
    github.tokens.set("acme/app", "token-app");
    const store = createWorkboardSqliteTestStore();
    // A rework verdict published an earlier round as a draft; this round reuses that PR.
    const publishOnDraft = async (
      pullRequestUrl: string,
      decide: (card: WorkboardCard) => Promise<unknown>,
    ) => {
      github.openPulls.splice(0, github.openPulls.length, pullRequestUrl);
      github.draftPulls.add(pullRequestUrl);
      const head = git(repos.hostRepo, "rev-parse", "HEAD");
      const card = await importedDocsTicket(store, {
        classRungs: { docs: { rung: "b", sampleEvery: 1 } },
        target: { ...NODE_TARGET, hostRepoPath: repos.hostRepo },
        headCommit: head,
      });
      git(repos.hostRepo, "branch", `factory/${card.id}`, head);
      await store.addComment(card.id, { body: "Verdict: accept" }, undefined, "agent:dev");
      await decide(card);
      const item = expectDefined(
        publishCandidate(expectDefined(await store.get(card.id), "card")),
        "publish candidate",
      );
      await publishNodeTicket({ store, github: github.access, item, now: Date.now });
      return expectDefined(await store.get(card.id), "card");
    };

    const agentPull = "https://github.com/acme/app/pull/102";
    const accepted = await publishOnDraft(
      agentPull,
      async (card) =>
        await agentTools(store)("workboard_move").execute("accept", {
          id: card.id,
          status: "done",
        }),
    );
    expect(github.draftPulls.has(agentPull)).toBe(false);
    expect(nodeTicketTarget(accepted)?.worktree?.handoff).toMatchObject({ phase: "published" });

    const operatorPull = "https://github.com/acme/app/pull/103";
    await publishOnDraft(
      operatorPull,
      async (card) => await store.move(card.id, "done", undefined),
    );
    expect(github.draftPulls.has(operatorPull)).toBe(true);
    expect(github.requests.filter((request) => request.url.endsWith("/graphql"))).toHaveLength(1);

    // GitHub refusing the ready mark leaves the agent's accept published, with a notice.
    github.failReady.value = true;
    const refusedPull = "https://github.com/acme/app/pull/104";
    const refused = await publishOnDraft(
      refusedPull,
      async (card) =>
        await agentTools(store)("workboard_move").execute("accept", {
          id: card.id,
          status: "done",
        }),
    );
    expect(github.draftPulls.has(refusedPull)).toBe(true);
    expect(refused.status).toBe("done");
    expect(nodeTicketTarget(refused)?.worktree?.reviews).toEqual([
      expect.objectContaining({ verdict: "accept", decidedBy: "agent", sampled: true }),
    ]);
    expect(refused.metadata?.comments?.at(-1)?.body).toContain(
      `${refusedPull}, but that PR is still a draft`,
    );
  });

  it("takes a sampled PR off Needs you once the operator marks it read, keeping the first read", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "workboard-rung-b-"));
    roots.push(root);
    const repos = createNodeRepos(root);
    git(repos.hostRepo, "remote", "set-url", "origin", "git@github.com:acme/app.git");
    const github = createFakeGitHub(repos.origin);
    github.tokens.set("acme/app", "token-app");
    const store = createWorkboardSqliteTestStore();
    const { api, invoke } = createGatewayMethodCapture();
    registerWorkboardGatewayMethods({ api, store });
    const head = git(repos.hostRepo, "rev-parse", "HEAD");
    const card = await importedDocsTicket(store, {
      classRungs: { docs: { rung: "b", sampleEvery: 1 } },
      target: { ...NODE_TARGET, hostRepoPath: repos.hostRepo },
      headCommit: head,
    });
    git(repos.hostRepo, "branch", `factory/${card.id}`, head);
    await store.addComment(card.id, { body: "Verdict: accept" }, undefined, "agent:dev");
    await agentTools(store)("workboard_move").execute("accept", { id: card.id, status: "done" });
    const item = expectDefined(
      publishCandidate(expectDefined(await store.get(card.id), "card")),
      "publish candidate",
    );
    await publishNodeTicket({ store, github: github.access, item, now: Date.now });
    const latestReview = async () =>
      nodeTicketTarget(expectDefined(await store.get(card.id), "card"))?.worktree?.reviews?.at(-1);
    expect((await store.overview(undefined)).needsYou).toEqual([
      expect.objectContaining({ cardId: card.id, reason: "sampled" }),
    ]);

    const read = await invoke("workboard.cards.sampleRead", { id: card.id });
    expect(read.mock.calls[0]?.[0]).toBe(true);
    const first = await latestReview();
    expect(first).toMatchObject({ sampled: true, readAt: expect.any(Number) });
    const overview = await store.overview(undefined);
    expect(overview.needsYou).toEqual([]);
    expect(overview.shipped).toEqual([expect.objectContaining({ cardId: card.id, sampled: true })]);

    // A later read must keep the first stamp, so give it a later clock.
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
    await invoke("workboard.cards.sampleRead", { id: card.id });
    vi.restoreAllMocks();
    expect(await latestReview()).toEqual(first);

    // The next publish appends its round unread, so a reworked PR waits for its own read.
    const worktree = expectDefined(
      nodeTicketTarget(expectDefined(await store.get(card.id), "card"))?.worktree,
      "worktree",
    );
    await store.setNodeHandoff(card.id, {
      worktreePath: worktree.path,
      handoff: {
        phase: "published",
        headCommit: head,
        importedAt: Date.now(),
        publishedAt: Date.now(),
        pullRequestUrl: "https://github.com/acme/app/pull/2",
      },
      review: { round: 1, verdict: "accept", decidedBy: "agent", sampled: true },
    });
    expect(
      nodeTicketTarget(expectDefined(await store.get(card.id), "card"))?.worktree?.reviews,
    ).toEqual([first, expect.not.objectContaining({ readAt: expect.anything() })]);
    expect((await store.overview(undefined)).needsYou).toEqual([
      expect.objectContaining({ cardId: card.id, reason: "sampled" }),
    ]);

    const unpublished = await importedDocsTicket(store);
    const refused = await invoke("workboard.cards.sampleRead", { id: unpublished.id });
    expect(refused.mock.calls[0]?.[0]).toBe(false);
    expect(JSON.stringify(refused.mock.calls[0])).toContain(
      "only a published node ticket an agent accepted into the review sample can be marked read",
    );
  });
});
