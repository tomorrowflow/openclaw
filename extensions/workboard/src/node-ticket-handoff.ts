import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { WorkboardCard, WorkboardNodeWorktree } from "@openclaw/workboard-contract";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  publishCandidate,
  publishNodeTicket,
  type WorkboardGitHubAccess,
} from "./node-ticket-publish.js";
import {
  HandoffSupersededError,
  hostGit,
  nodeInvokePayload,
  nodeTicketReopen,
  nodeTicketTarget,
  requireHostGit,
  runNodeCommand,
  type WorkboardNodeTicketRuntime,
} from "./node-ticket.js";
import { cardRunId, cardSessionKey } from "./store-card-helpers.js";
import { workboardCardConsumesNodeTicketSlot } from "./store-constants.js";
import type { WorkboardStore } from "./store.js";

// file.fetch's hard cap; a larger bundle fails on the node with FILE_TOO_LARGE.
const BUNDLE_MAX_BYTES = 16 * 1024 * 1024;

type HandoffCard = {
  card: WorkboardCard;
  nodeId: string;
  repoPath: string;
  hostRepoPath: string;
  worktree: WorkboardNodeWorktree & { handoff: NonNullable<WorkboardNodeWorktree["handoff"]> };
  bundlePath: string;
};

function handoffCard(card: WorkboardCard): HandoffCard | undefined {
  const target = nodeTicketTarget(card);
  const worktree = target?.worktree;
  // A rework start (D54) or an answered ticket's start claims the card, so it
  // is running, before it swaps out the published or questions worktree
  // record. Neither handoff is an import to resume; cleaning up after one
  // would delete the worktree the start is about to reuse.
  if (
    !target ||
    !worktree?.handoff ||
    worktree.handoff.phase === "published" ||
    worktree.handoff.phase === "questions" ||
    card.status !== "running" ||
    card.metadata?.archivedAt
  ) {
    return undefined;
  }
  return {
    card,
    nodeId: target.nodeId,
    repoPath: target.repoPath,
    hostRepoPath: target.hostRepoPath,
    worktree: { ...worktree, handoff: worktree.handoff },
    bundlePath: path.posix.join(target.worktreesRoot, `wb-${card.id}.bundle`),
  };
}

async function fetchNodeBundle(
  runtime: WorkboardNodeTicketRuntime,
  nodeId: string,
  bundlePath: string,
): Promise<Buffer> {
  const payload = nodeInvokePayload(
    await runtime.request(
      "node.invoke",
      {
        nodeId,
        command: "file.fetch",
        params: { path: bundlePath, maxBytes: BUNDLE_MAX_BYTES },
        idempotencyKey: randomUUID(),
      },
      { scopes: ["operator.admin"] },
    ),
  );
  if (payload.ok === false) {
    const reason = [payload.code, payload.message].filter((part) => typeof part === "string");
    throw new Error(`node ${nodeId} could not send ${bundlePath}: ${reason.join(" ") || "error"}`);
  }
  if (typeof payload.base64 !== "string" || typeof payload.sha256 !== "string") {
    throw new Error(`node ${nodeId} returned an invalid file.fetch payload for ${bundlePath}`);
  }
  const bundle = Buffer.from(payload.base64, "base64");
  if (createHash("sha256").update(bundle).digest("hex") !== payload.sha256.toLowerCase()) {
    throw new Error(`the fetched bundle ${bundlePath} does not match its sha256`);
  }
  return bundle;
}

/**
 * Bundles the ticket branch on the node and imports it into the host clone.
 * The bundle must carry exactly the ticket branch, descend from the recorded
 * base commit, and never move an existing host branch to another commit.
 */
async function importNodeBundle(
  runtime: WorkboardNodeTicketRuntime,
  item: HandoffCard,
  assertCurrent: () => Promise<void>,
): Promise<string> {
  const { nodeId, worktree, bundlePath, hostRepoPath } = item;
  const git = (...args: string[]) =>
    runNodeCommand(runtime, nodeId, ["git", "-C", worktree.path, ...args]);
  const dirty = await git("status", "--porcelain");
  if (dirty) {
    throw new Error(
      `the node worktree ${worktree.path} has uncommitted changes:\n${dirty.split("\n").slice(0, 10).join("\n")}`,
    );
  }
  // Commits made off the ticket branch would not be bundled, and cleanup would lose them.
  const checkedOutRef = await git("rev-parse", "--symbolic-full-name", "HEAD");
  const worktreeHead = await git("rev-parse", "HEAD");
  if (checkedOutRef !== `refs/heads/${worktree.branch}`) {
    throw new Error(
      `the node worktree ${worktree.path} is not on ${worktree.branch} (HEAD is ${checkedOutRef || "unknown"})`,
    );
  }
  await git("bundle", "create", bundlePath, `${worktree.baseCommit}..${worktree.branch}`);
  const bundle = await fetchNodeBundle(runtime, nodeId, bundlePath);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "workboard-bundle-"));
  try {
    const localBundle = path.join(tempDir, path.posix.basename(bundlePath));
    await fs.writeFile(localBundle, bundle);
    // The node based the ticket on a freshly fetched origin; the host clone may lag behind it.
    const hasBase = await hostGit(hostRepoPath, [
      "cat-file",
      "-e",
      `${worktree.baseCommit}^{commit}`,
    ]);
    if (hasBase.code !== 0) {
      await requireHostGit(hostRepoPath, ["fetch", "--quiet", "origin"]);
    }
    await requireHostGit(hostRepoPath, ["bundle", "verify", "--quiet", localBundle]);
    const ref = `refs/heads/${worktree.branch}`;
    const heads = (await requireHostGit(hostRepoPath, ["bundle", "list-heads", localBundle]))
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split(" "));
    const headCommit = heads.length === 1 && heads[0]?.[1] === ref ? heads[0][0] : undefined;
    if (!headCommit) {
      throw new Error(`the bundle must contain only ${ref}, found: ${heads.join(", ") || "none"}`);
    }
    if (headCommit !== worktreeHead) {
      throw new Error(`the bundle head ${headCommit} is not the worktree HEAD ${worktreeHead}`);
    }
    await requireHostGit(hostRepoPath, ["fetch", "--no-write-fetch-head", localBundle, ref]);
    const ancestry = await hostGit(hostRepoPath, [
      "merge-base",
      "--is-ancestor",
      worktree.baseCommit,
      headCommit,
    ]);
    if (ancestry.code !== 0) {
      throw new Error(`${worktree.branch} does not descend from base ${worktree.baseCommit}`);
    }
    const existing = await hostGit(hostRepoPath, ["rev-parse", "--verify", "--quiet", ref]);
    const existingHead = existing.code === 0 ? existing.stdout.trim() : "";
    // Only a rework round (D54) may move the branch, and only forward from what it published.
    if (
      existingHead &&
      existingHead !== headCommit &&
      (!worktree.rework ||
        (await hostGit(hostRepoPath, ["merge-base", "--is-ancestor", existingHead, headCommit]))
          .code !== 0)
    ) {
      throw new Error(
        `the host clone already has ${worktree.branch} at ${existingHead}; delete or rename it`,
      );
    }
    await assertCurrent();
    if (existingHead !== headCommit) {
      // The old value makes git refuse if another writer moved or created the ref meanwhile.
      await requireHostGit(hostRepoPath, ["update-ref", ref, headCommit, existingHead]);
    }
    return headCommit;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

/** The import is confirmed on the host, so the node's worktree, branch, and bundle can go. */
async function cleanupNodeTicket(
  runtime: WorkboardNodeTicketRuntime,
  item: HandoffCard,
): Promise<void> {
  const { nodeId, repoPath, worktree, bundlePath } = item;
  await runNodeCommand(runtime, nodeId, [
    "git",
    "-C",
    repoPath,
    "worktree",
    "remove",
    worktree.path,
  ]);
  await runNodeCommand(runtime, nodeId, ["git", "-C", repoPath, "branch", "-D", worktree.branch]);
  await runNodeCommand(runtime, nodeId, ["rm", "-f", bundlePath]);
}

async function runNodeTicketHandoff(params: {
  runtime: WorkboardNodeTicketRuntime;
  store: WorkboardStore;
  item: HandoffCard;
  now: () => number;
}): Promise<void> {
  const { runtime, store, item } = params;
  const { card, worktree } = item;
  const claim = card.metadata?.claim;
  const scope = claim ? { ownerId: claim.ownerId, token: claim.token } : undefined;
  if (worktree.handoff.phase === "pending") {
    let headCommit: string;
    try {
      headCommit = await importNodeBundle(runtime, item, async () => {
        // The card may have been cancelled or re-dispatched while the bundle travelled.
        const current = await store.get(card.id);
        const fresh = current ? handoffCard(current) : undefined;
        if (
          !fresh ||
          fresh.nodeId !== item.nodeId ||
          fresh.repoPath !== item.repoPath ||
          fresh.hostRepoPath !== item.hostRepoPath ||
          fresh.worktree.path !== worktree.path ||
          fresh.worktree.branch !== worktree.branch ||
          fresh.worktree.baseCommit !== worktree.baseCommit ||
          fresh.worktree.handoff.phase !== "pending" ||
          current?.metadata?.claim?.token !== claim?.token
        ) {
          throw new HandoffSupersededError();
        }
      });
    } catch (error) {
      if (error instanceof HandoffSupersededError) {
        return;
      }
      await store.block(
        card.id,
        {
          reason: `Bundle import failed: ${formatErrorMessage(error)}\nFix the cause, then re-run the card; the next run reuses the node worktree and imports again.`,
        },
        scope,
      );
      return;
    }
    const range = `${worktree.baseCommit.slice(0, 12)}..${headCommit.slice(0, 12)}`;
    await store.addProof(
      card.id,
      {
        label: "bundle import",
        status: "passed",
        command: `git fetch wb-${card.id}.bundle ${worktree.branch}`,
        note: `Imported ${worktree.branch} ${range} into ${item.hostRepoPath}`,
      },
      scope,
    );
    await store.setNodeHandoff(
      card.id,
      {
        worktreePath: worktree.path,
        handoff: { phase: "imported", headCommit, importedAt: params.now() },
      },
      scope,
    );
  }
  try {
    await cleanupNodeTicket(runtime, item);
  } catch (error) {
    await store.addComment(
      card.id,
      {
        body: `Node cleanup after the import failed; remove it on ${item.nodeId} by hand: ${formatErrorMessage(error)}`,
      },
      scope,
    );
  }
  const sessionKey = cardSessionKey(card);
  const runId = cardRunId(card);
  const now = params.now();
  await store.syncLifecycle(card.id, {
    targetStatus: "review",
    executionStatus: "review",
    sourceUpdatedAt: now,
    stale: undefined,
    now,
    ...(sessionKey
      ? {
          association: {
            expectedSessionKey: sessionKey,
            ...(runId ? { expectedRunId: runId, runId } : {}),
            sessionKey,
          },
        }
      : {}),
  });
  // The claim fenced the node turn, which is over. Holding it through review
  // would refuse a rework start until it expires (D54).
  const current = claim ? await store.get(card.id) : undefined;
  if (current?.status === "review" && current.metadata?.claim?.token === claim?.token) {
    await store.releaseClaim(card.id, { ownerId: claim?.ownerId, token: claim?.token });
  }
}

/** Starts one card through the dispatcher's exact start path. */
export type WorkboardNodeTicketStart = (
  cardId: string,
) => Promise<{ startFailures: ReadonlyArray<{ error: string }> }>;

/**
 * D56: a published ticket moved back to todo starts its rework round once it
 * carries a review comment, waits while the node-ticket pool is full, and
 * goes back to backlog with the next step when no review comment says what
 * should change. A ticket waiting with questions resumes the same way once a
 * comment answers them, and goes back to review without one.
 */
async function reopenNodeTicket(params: {
  store: WorkboardStore;
  start: WorkboardNodeTicketStart;
  card: WorkboardCard;
  now: () => number;
}): Promise<void> {
  const { store, card } = params;
  const reopen = nodeTicketReopen(card, params.now());
  if (!reopen) {
    return;
  }
  const { worktreePath, round } = reopen;
  const rework = reopen.kind === "rework";
  const what = rework ? `Rework round ${round}` : "The answer";
  if (!reopen.reviewed) {
    await store.addNodeTicketNotice(card.id, {
      worktreePath,
      kind: "reviewFrom",
      status: rework ? "backlog" : "review",
      body: rework
        ? `Reopened without a review comment; add what should change and move it to todo again to start rework round ${round}.`
        : "Moved to todo without an answer; answer the questions in a comment and move it to todo again to resume the session.",
      applies: (current) => nodeTicketReopen(current, params.now())?.reviewed === false,
    });
    return;
  }
  const { startFailures } = await params.start(card.id);
  const failure = startFailures[0];
  // A start that claimed the card already blocked it on failure; only a
  // refusal before the claim leaves the reopened card in todo.
  const current = failure ? await store.get(card.id) : undefined;
  const still = current ? nodeTicketReopen(current, params.now()) : undefined;
  if (!failure || !current || !still?.reviewed) {
    return;
  }
  const at = params.now();
  const busy =
    (await store.list()).filter((entry) => workboardCardConsumesNodeTicketSlot(entry, at)).length >=
    store.nodeTicketConcurrency;
  if (busy) {
    if (!still.slotWaitNoted) {
      await store.addNodeTicketNotice(card.id, {
        worktreePath,
        kind: "slotWait",
        body: `${what} waits for a node-ticket slot; it starts when a running node ticket reaches review.`,
        applies: (latest) => nodeTicketReopen(latest, params.now())?.slotWaitNoted === false,
      });
    }
    return;
  }
  await store.block(
    card.id,
    {
      reason: `${what} could not start: ${failure.error}\nFix the cause, then move the card to todo again.`,
    },
    null,
  );
}

/** A ticket moved to done while it waits with questions has no commits to publish. */
function unansweredDone(card: WorkboardCard): string | undefined {
  const worktree = nodeTicketTarget(card)?.worktree;
  return card.status === "done" &&
    !card.metadata?.archivedAt &&
    worktree?.handoff?.phase === "questions"
    ? worktree.path
    : undefined;
}

/**
 * Owns moving finished node tickets from a pending handoff to review,
 * accepted ones from done to a draft PR, reopened published ones into
 * their next rework round, and answered ones back into their session. The agent_end report and card changes start it
 * right away and the lifecycle sweep resumes it after a restart; each card
 * runs at most once at a time.
 */
export function createNodeTicketHandoffs(params: {
  store: WorkboardStore;
  runtime: WorkboardNodeTicketRuntime;
  github: WorkboardGitHubAccess;
  start: WorkboardNodeTicketStart;
  now?: () => number;
}) {
  const inFlight = new Set<string>();
  const now = params.now ?? Date.now;
  return {
    async resume(warn: (message: string) => void): Promise<void> {
      for (const card of await params.store.list()) {
        const item = handoffCard(card);
        const publish = item ? undefined : publishCandidate(card);
        const reopen = item || publish ? undefined : nodeTicketReopen(card, now());
        const unanswered = unansweredDone(card);
        if ((!item && !publish && !reopen && !unanswered) || inFlight.has(card.id)) {
          continue;
        }
        inFlight.add(card.id);
        try {
          if (item) {
            await runNodeTicketHandoff({ runtime: params.runtime, store: params.store, item, now });
          } else if (publish) {
            await publishNodeTicket({
              store: params.store,
              github: params.github,
              item: publish,
              now,
            });
          } else if (reopen) {
            await reopenNodeTicket({ store: params.store, start: params.start, card, now });
          } else if (unanswered) {
            await params.store.addNodeTicketNotice(card.id, {
              worktreePath: unanswered,
              kind: "reviewFrom",
              status: "review",
              body: "This ticket stopped with open questions and has no commits to publish. Answer them in a comment and move it to todo, or archive the card; its node worktree stays until removed by hand.",
              applies: (current) => unansweredDone(current) === unanswered,
            });
          }
        } catch (error) {
          warn(`workboard node handoff failed for card ${card.id}: ${formatErrorMessage(error)}`);
        } finally {
          inFlight.delete(card.id);
        }
      }
    },
  };
}

export type WorkboardNodeTicketHandoffs = ReturnType<typeof createNodeTicketHandoffs>;
