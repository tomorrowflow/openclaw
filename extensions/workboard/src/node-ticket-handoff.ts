import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { WorkboardCard, WorkboardNodeWorktree } from "@openclaw/workboard-contract";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { WorkboardLifecycleSessionReader } from "./lifecycle-sync.js";
import { fetchNodeFile } from "./node-files.js";
import {
  nodeGrillSessionToOpen,
  openNodeGrillSession,
  readNodeGrillResult,
} from "./node-ticket-grill-session.js";
import {
  publishCandidate,
  publishNodeTicket,
  type WorkboardGitHubAccess,
} from "./node-ticket-publish.js";
import { parseNumstat } from "./node-ticket-rounds.js";
import {
  HandoffSupersededError,
  hostGit,
  nodeTicketReopen,
  nodeTicketReopenSubject,
  nodeTicketTarget,
  requireHostGit,
  runNodeCommand,
  type WorkboardNodeTicketRuntime,
} from "./node-ticket.js";
import { cardRunId, cardSessionKey } from "./store-card-helpers.js";
import { MAX_BLOCK_REASON_CHARS, MAX_PROOF_NOTE_CHARS } from "./store-constants.js";
import { capText } from "./store-normalizers.js";
import type { WorkboardStore } from "./store.js";

// file.fetch's hard cap; a larger bundle fails on the node with FILE_TOO_LARGE.
const MAX_IMPORT_CHECK_FENCE = 16;
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
  // is running, before it swaps out the published, questions, or grilling
  // worktree record. None is an import to resume; cleaning up after one
  // would delete the worktree the start is about to reuse. A re-run of a card
  // whose import failed claims it after the done report, so that pending
  // record is the failed one, not this start's.
  const claim = card.metadata?.claim;
  if (
    !target ||
    !worktree?.handoff ||
    worktree.handoff.phase === "published" ||
    worktree.handoff.phase === "questions" ||
    worktree.handoff.phase === "grilling" ||
    (worktree.handoff.phase === "pending" &&
      claim &&
      claim.claimedAt > worktree.handoff.reportedAt) ||
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

/** The imported range fails `git diff --check`, a mechanical check review should not have to catch. */
class ImportCheckError extends Error {
  constructor(
    readonly command: string,
    readonly output: string,
  ) {
    super(`\`${command}\` failed`);
  }
}

type ImportedBundle = {
  from: string;
  headCommit: string;
  /** A rework round whose own commits are all merges, or none. */
  reworkUnchanged?: true;
};

/**
 * Bundles the ticket branch on the node and imports it into the host clone.
 * The bundle must carry exactly the ticket branch, descend from the recorded
 * base commit, and never move an existing host branch to another commit.
 */
async function importNodeBundle(
  runtime: WorkboardNodeTicketRuntime,
  item: HandoffCard,
  assertCurrent: () => Promise<void>,
): Promise<ImportedBundle> {
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
  const bundle = await fetchNodeFile(runtime, nodeId, bundlePath, BUNDLE_MAX_BYTES);
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
    // A rework round answers for its own commits, not for what a reviewer pushed
    // (an "Update branch" merge carries all of main). Records from before
    // startCommit fall back to the head the host imported last.
    const checkFrom = worktree.rework
      ? (worktree.rework.startCommit ?? (existingHead || worktree.baseCommit))
      : worktree.baseCommit;
    const check = await hostGit(hostRepoPath, ["diff", "--check", checkFrom, headCommit]);
    if (check.code !== 0 && check.stdout.trim()) {
      // A superseded card must not be blocked by its stale import.
      await assertCurrent();
      throw new ImportCheckError(
        `git diff --check ${checkFrom.slice(0, 12)}..${headCommit.slice(0, 12)}`,
        check.stdout.trim(),
      );
    }
    if (check.code !== 0) {
      throw new Error(
        `host \`git diff --check\` failed: ${check.stderr.trim() || `exit ${check.code}`}`,
      );
    }
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
    // The round's own commits: --first-parent leaves out what a merge brings
    // in from main. Only a recorded start commit bounds the round; the
    // fallback head moves with a retried import. Accepted edge cases: a merge
    // carrying manual conflict-resolution edits, or merging a side branch of
    // the agent's own commits, counts as unchanged. The count only feeds the
    // trust KPIs, so a failed count leaves the round counted as rework.
    const startCommit = worktree.rework?.startCommit;
    const ownCommits = startCommit
      ? await hostGit(hostRepoPath, [
          "rev-list",
          "--count",
          "--first-parent",
          "--no-merges",
          `${startCommit}..${headCommit}`,
        ])
      : undefined;
    const reworkUnchanged = ownCommits?.code === 0 && ownCommits.stdout.trim() === "0";
    return { from: checkFrom, headCommit, ...(reworkUnchanged ? { reworkUnchanged: true } : {}) };
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
  warn: (message: string) => void;
}): Promise<void> {
  const { runtime, store, item } = params;
  const { card, worktree } = item;
  const claim = card.metadata?.claim;
  const scope = claim ? { ownerId: claim.ownerId, token: claim.token } : undefined;
  if (worktree.handoff.phase === "pending") {
    let imported: ImportedBundle;
    try {
      imported = await importNodeBundle(runtime, item, async () => {
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
      if (error instanceof ImportCheckError) {
        await store.addProof(
          card.id,
          {
            label: "import check",
            status: "failed",
            command: error.command,
            note: capText(error.output, MAX_PROOF_NOTE_CHARS),
          },
          scope,
        );
        // The reason becomes a comment the re-run session sees cut to 400
        // characters, so the command and its output come first. The output
        // is capped inside the fence, so the fence always closes. The fence
        // length is bounded so a backtick-heavy diff cannot eat the budget.
        const lead = `Import check: ${error.message}; fix it with a new commit in the same worktree, then re-run the card to import again.`;
        const fence = "`".repeat(
          Math.min(
            MAX_IMPORT_CHECK_FENCE,
            Math.max(3, ...(error.output.match(/`+/g) ?? []).map((run) => run.length + 1)),
          ),
        );
        await store.block(
          card.id,
          {
            reason: `${lead}\n${fence}\n${capText(error.output, MAX_BLOCK_REASON_CHARS - lead.length - 2 * fence.length - 3) ?? ""}\n${fence}`,
          },
          scope,
        );
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
    const { headCommit } = imported;
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
    // The diffstat only informs the operator; the import stands without it.
    const numstat = await hostGit(item.hostRepoPath, [
      "diff",
      "--numstat",
      "-z",
      "-M",
      imported.from,
      headCommit,
    ]);
    if (numstat.code === 0) {
      await store.recordNodeRound(
        card.id,
        {
          worktreePath: worktree.path,
          changes: parseNumstat(numstat.stdout, imported.from, headCommit),
        },
        scope,
      );
    } else {
      params.warn(
        `workboard could not record the changed files of card ${card.id}: ${numstat.stderr.trim() || `exit ${numstat.code}`}`,
      );
    }
    await store.setNodeHandoff(
      card.id,
      {
        worktreePath: worktree.path,
        handoff: { phase: "imported", headCommit, importedAt: params.now() },
        ...(imported.reworkUnchanged ? { reworkUnchanged: true } : {}),
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

/**
 * Starts one card through the dispatcher's exact start path. `request`
 * queues it while its slot is full; `drain` starts it only while it is queued.
 */
export type WorkboardNodeTicketStart = (
  cardId: string,
  queue: "request" | "drain",
) => Promise<{
  startFailures: ReadonlyArray<{ error: string; changed?: true }>;
  queued?: WorkboardCard;
}>;

/**
 * D56: a published ticket moved back to todo starts its rework round once it
 * carries a review comment, queues while the node-ticket pool is full, and
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
  if (!reopen.reviewed) {
    await store.addNodeTicketNotice(card.id, {
      worktreePath,
      status: rework ? "backlog" : "review",
      body: rework
        ? `Reopened without a review comment; add what should change and move it to todo again to start rework round ${round}.`
        : reopen.kind === "grill"
          ? "Moved to todo while grilling; the grilling goes on in its grill session, which the card names once it is open. Finish it there, or choose End grilling on the card to let the agent continue with the grill session's last reply, if it has one."
          : "Moved to todo without an answer; answer the questions in a comment and move it to todo again to resume the session.",
      applies: (current) => nodeTicketReopen(current, params.now())?.reviewed === false,
    });
    return;
  }
  const { startFailures, queued } = await params.start(card.id, "request");
  const failure = startFailures[0];
  // A start that claimed the card already blocked it on failure; only a
  // refusal before the claim leaves the reopened card in todo.
  const current = failure && !queued ? await store.get(card.id) : undefined;
  if (!failure || !current || !nodeTicketReopen(current, params.now())?.reviewed) {
    return;
  }
  const what = nodeTicketReopenSubject(reopen);
  await store.block(
    card.id,
    {
      reason: `${what} could not start: ${failure.error}\nFix the cause, then move the card to todo again.`,
    },
    null,
  );
}

/**
 * Starts one queued node ticket. A card whose slot is still full, or that
 * changed while the start read it, stays queued for the next card change; any
 * other refusal blocks it with the reason.
 */
async function drainStartQueue(params: {
  store: WorkboardStore;
  start: WorkboardNodeTicketStart;
  card: WorkboardCard;
}): Promise<void> {
  const { startFailures, queued } = await params.start(params.card.id, "drain");
  const failure = startFailures[0];
  if (!failure || queued || failure.changed) {
    return;
  }
  // A start that claimed the card already blocked it on failure.
  const current = await params.store.get(params.card.id);
  if (!current?.metadata?.automation?.startRequest) {
    return;
  }
  await params.store.block(
    params.card.id,
    {
      reason: `The queued start failed: ${failure.error}\nFix the cause, then start the card again.`,
    },
    null,
  );
}

/**
 * A ticket moved to done while it waits with questions or on a grilling
 * answer has nothing to publish yet.
 */
function unansweredDone(
  card: WorkboardCard,
): { worktreePath: string; phase: "questions" | "grilling" } | undefined {
  const worktree = nodeTicketTarget(card)?.worktree;
  const phase = worktree?.handoff?.phase;
  if (card.status !== "done" || card.metadata?.archivedAt || !worktree) {
    return undefined;
  }
  return phase === "questions" || phase === "grilling"
    ? { worktreePath: worktree.path, phase }
    : undefined;
}

/**
 * Owns moving finished node tickets from a pending handoff to review,
 * accepted ones from done to a draft PR, reopened published ones into
 * their next rework round, answered ones back into their session, and
 * handed-off grillings into their grill session. The agent_end report and
 * card changes start it right away and the lifecycle sweep resumes it after
 * a restart; each card runs at most once at a time.
 */
export function createNodeTicketHandoffs(params: {
  store: WorkboardStore;
  runtime: WorkboardNodeTicketRuntime;
  github: WorkboardGitHubAccess;
  start: WorkboardNodeTicketStart;
  /** Wakes the board automation once an import moved the card to review. */
  onReview?: (card: WorkboardCard) => Promise<void>;
  /** The session owner's view, which says whether a grill session is still replying. */
  readSessions?: WorkboardLifecycleSessionReader;
  now?: () => number;
}) {
  const inFlight = new Set<string>();
  const now = params.now ?? Date.now;
  return {
    async resume(warn: (message: string) => void): Promise<void> {
      for (const card of await params.store.list()) {
        const item = handoffCard(card);
        const publish = item ? undefined : publishCandidate(card);
        // The queue drain below owns a queued reopen's start.
        const reopen =
          item || publish || card.metadata?.automation?.startRequest
            ? undefined
            : nodeTicketReopen(card, now());
        const unanswered = unansweredDone(card);
        const grilling = nodeGrillSessionToOpen(card);
        if ((!item && !publish && !reopen && !unanswered && !grilling) || inFlight.has(card.id)) {
          continue;
        }
        inFlight.add(card.id);
        try {
          if (item) {
            await runNodeTicketHandoff({
              runtime: params.runtime,
              store: params.store,
              item,
              now,
              warn,
            });
            const current = await params.store.get(card.id);
            if (current?.status === "review") {
              await params.onReview?.(current);
            }
          } else if (publish) {
            await publishNodeTicket({
              store: params.store,
              github: params.github,
              item: publish,
              now,
            });
          } else if (reopen) {
            await reopenNodeTicket({ store: params.store, start: params.start, card, now });
          } else if (grilling) {
            await openNodeGrillSession({
              store: params.store,
              runtime: params.runtime,
              readSessions: params.readSessions,
              card,
              worktree: grilling,
              warn,
            });
          } else if (unanswered?.phase === "grilling") {
            // The grill session's last reply is the result, so a reply still
            // running keeps the grilling live; a later pass or the sweep ends it.
            const read = await readNodeGrillResult(
              params.runtime,
              params.readSessions,
              nodeTicketTarget(card)?.worktree?.grill?.sessionKey,
            );
            if (read.replying) {
              continue;
            }
            // The card change this move makes finds the card in flight, so its reopen runs here.
            const moved = await params.store.endNodeGrillMovedToDone(card.id, {
              ...unanswered,
              result: read.result,
            });
            if (moved) {
              await reopenNodeTicket({
                store: params.store,
                start: params.start,
                card: moved,
                now,
              });
            }
          } else if (unanswered) {
            const { worktreePath } = unanswered;
            await params.store.addNodeTicketNotice(card.id, {
              worktreePath,
              status: "review",
              body: "This ticket stopped with open questions, so there is nothing to publish yet. Answer them in a comment and move it to todo, or archive the card; its node worktree stays until removed by hand.",
              applies: (current) => {
                const still = unansweredDone(current);
                return still?.phase === "questions" && still.worktreePath === worktreePath;
              },
            });
          }
        } catch (error) {
          warn(`workboard node handoff failed for card ${card.id}: ${formatErrorMessage(error)}`);
        } finally {
          inFlight.delete(card.id);
        }
      }
      // Oldest request first; a card whose route is still full does not hold
      // back a later one on a route with a free slot.
      const queue = (await params.store.list())
        .filter((card) => card.metadata?.automation?.startRequest)
        .toSorted(
          (left, right) =>
            (left.metadata?.automation?.startRequest?.requestedAt ?? 0) -
            (right.metadata?.automation?.startRequest?.requestedAt ?? 0),
        );
      for (const card of queue) {
        if (inFlight.has(card.id)) {
          continue;
        }
        inFlight.add(card.id);
        try {
          await drainStartQueue({ store: params.store, start: params.start, card });
        } catch (error) {
          warn(`workboard queued start failed for card ${card.id}: ${formatErrorMessage(error)}`);
        } finally {
          inFlight.delete(card.id);
        }
      }
    },
  };
}

export type WorkboardNodeTicketHandoffs = ReturnType<typeof createNodeTicketHandoffs>;
