import path from "node:path";
import type {
  WorkboardCard,
  WorkboardNodeGrill,
  WorkboardNodeWorktree,
} from "@openclaw/workboard-contract";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { WorkboardLifecycleSessionReader } from "./lifecycle-sync.js";
import { withNodeBundle } from "./node-ticket-bundle.js";
import { grillHandoffFromLog, grillSessionName, nodeGrillIsLive } from "./node-ticket-grill.js";
import { lastAssistantReply } from "./node-ticket-report.js";
import {
  nodeTicketTarget,
  requireHostGit,
  runNodeCommand,
  sessionCreateRunError,
  type WorkboardNodeTicketRuntime,
} from "./node-ticket.js";
import {
  sanitizeSessionSegment,
  sessionProvesPreparedAcceptance,
  workboardSessionHasActiveRun,
} from "./session-link.js";
import { MAX_BLOCK_REASON_CHARS } from "./store-constants.js";
import { capText } from "./store-normalizers.js";
import type { WorkboardStore } from "./store.js";

const GRILL_SESSION_GROUP = "Grilling";

// A failed copy's reason in the grill prompt: its first line, as git's stderr can run long.
const MAX_COPY_ERROR_CHARS = 300;

// The grill session's last messages hold its last reply; earlier ones are not read.
const GRILL_HISTORY_LIMIT = 20;

/**
 * The grill session runs on the Gateway, which cannot reach the node, so the
 * ticket branch is copied into the host clone under this ref before the
 * session opens. Each round overwrites it; the bundle import deletes it.
 * Accepted edge case: a card archived from review without an import leaves
 * the ref (and its objects) in the host clone until someone deletes it.
 */
export function grillBranchRef(cardId: string): string {
  return `refs/workboard/grill/${cardId}`;
}

/** Where the grill session finds the ticket branch: its ref, no commits yet, or why the copy failed. */
type GrillBranch = { ref: string } | { empty: true } | { error: string };

async function copyGrillBranch(
  runtime: WorkboardNodeTicketRuntime,
  card: WorkboardCard,
): Promise<GrillBranch | undefined> {
  const target = nodeTicketTarget(card);
  const worktree = target?.worktree;
  if (!target || !worktree) {
    return undefined;
  }
  const head = await runNodeCommand(runtime, target.nodeId, [
    "git",
    "-C",
    worktree.path,
    "rev-parse",
    worktree.branch,
  ]);
  if (head === worktree.baseCommit) {
    return { empty: true };
  }
  const ref = grillBranchRef(card.id);
  const bundlePath = path.posix.join(target.worktreesRoot, `wb-${card.id}.bundle`);
  await withNodeBundle(
    runtime,
    { nodeId: target.nodeId, worktree, bundlePath, hostRepoPath: target.hostRepoPath },
    async (localBundle) => {
      await requireHostGit(target.hostRepoPath, [
        "fetch",
        "--no-write-fetch-head",
        localBundle,
        `+refs/heads/${worktree.branch}:${ref}`,
      ]);
    },
  );
  // The copy landed; a bundle left behind is replaced by the next one and removed by cleanup.
  await runNodeCommand(runtime, target.nodeId, ["rm", "-f", bundlePath]).catch(() => undefined);
  return { ref };
}

function grillBranchLines(card: WorkboardCard, branch: GrillBranch | undefined): string[] {
  const target = nodeTicketTarget(card);
  if (!target || !branch) {
    return [];
  }
  const checkout = `The repository is checked out at \`${target.hostRepoPath}\``;
  const ticketBranch = target.worktree?.branch ?? "its ticket branch";
  if ("ref" in branch) {
    const base = target.worktree?.baseCommit.slice(0, 12) ?? "main";
    return [
      `${checkout}. The ticket branch \`${ticketBranch}\` is copied into it as \`${branch.ref}\`, with the commits it had when this session opened (uncommitted work stays on the node). In that checkout, list its changes with \`git diff --stat ${base} ${branch.ref}\` and read a file with \`git show ${branch.ref}:<path>\`.`,
    ];
  }
  if ("empty" in branch) {
    return [`${checkout}. The ticket branch \`${ticketBranch}\` has no commits yet.`];
  }
  return [
    `${checkout}; the ticket's own commits are on branch \`${ticketBranch}\` on the node and could not be copied here (${branch.error}). Use the handoff and the card's comments instead.`,
  ];
}

function grillSessionMessage(
  card: WorkboardCard,
  handoff: string | undefined,
  branch: GrillBranch | undefined,
): string {
  return [
    `Grill the operator on this Workboard ticket: ${card.title} (card \`${card.id}\`)`,
    ...grillBranchLines(card, branch),
    "",
    ...(handoff
      ? [
          "The ticket's session researched it and handed the grilling off to this session. Its handoff:",
          "",
          handoff,
        ]
      : [
          "The ticket's session researched it and handed the grilling off to this session, but the card's grilling log (`grilling.md`) reached its size limit, which cut the handoff. Read the card with `workboard_read` and the grilling log for what the ticket session found, and ask about what they leave open.",
        ]),
    "",
    "## How to grill",
    "- Interview the operator one question at a time until you share an understanding of what to build. Give your recommended answer with each question, and start with the handoff's first question.",
    "- Look facts up yourself (the repository, the docs, the card with `workboard_read`) instead of asking the operator for them.",
    "- Do not build anything, change files, or move the card. This session only settles what to build.",
    "- When the operator confirms the shared understanding, write the result as a handoff for the ticket session: the settled decisions, the terms you agreed on, open risks, and what the ticket session should do next. Call `workboard_grill_done` with it as `handoff`; the ticket session then resumes with it.",
  ].join("\n");
}

/** A grilling whose grill session is still to be created: the card waits in review on it. */
export function nodeGrillSessionToOpen(
  card: WorkboardCard,
): (WorkboardNodeWorktree & { grill: WorkboardNodeGrill }) | undefined {
  const worktree = nodeTicketTarget(card)?.worktree;
  const grill = worktree?.grill;
  return worktree &&
    grill &&
    !grill.sessionKey &&
    card.status === "review" &&
    nodeGrillIsLive(card, worktree)
    ? { ...worktree, grill }
    : undefined;
}

/**
 * Creates the grill session: a normal session of the card's agent on the
 * Gateway, with its agent's own model, that starts on the handoff.
 */
async function startNodeGrillSession(
  runtime: WorkboardNodeTicketRuntime,
  card: WorkboardCard,
  key: string,
  handoff: string | undefined,
  branch: GrillBranch | undefined,
): Promise<string> {
  const result = await runtime.request(
    "sessions.create",
    {
      key,
      ...(card.agentId ? { agentId: card.agentId } : {}),
      displayName: grillSessionName(card),
      // Groups the grill sessions in the session list, like an operator-made group.
      category: GRILL_SESSION_GROUP,
      message: grillSessionMessage(card, handoff, branch),
    },
    { scopes: ["operator.admin"] },
  );
  const record = isRecord(result) ? result : {};
  if (record.runStarted === false) {
    throw new Error(sessionCreateRunError(record));
  }
  return typeof record.key === "string" && record.key ? record.key : key;
}

/**
 * Opens the grill session of a grilling that waits for one and records it on
 * the card, which then names it. The key names the card and the round, so a
 * pass after a create whose session was not recorded adopts the session once
 * it ran its handoff turn, instead of sending the handoff again; a session
 * whose run never started gets the create again. A session that cannot start
 * blocks the card; a move to todo brings it back to review, where the next
 * pass tries again.
 */
export async function openNodeGrillSession(params: {
  store: WorkboardStore;
  runtime: WorkboardNodeTicketRuntime;
  readSessions: WorkboardLifecycleSessionReader | undefined;
  card: WorkboardCard;
  worktree: WorkboardNodeWorktree & { grill: WorkboardNodeGrill };
  warn: (message: string) => void;
}): Promise<void> {
  const { store, card, worktree } = params;
  const round = worktree.grill.rounds;
  const name = `grill-${sanitizeSessionSegment(card.id.slice(0, 8), "card")}-${round}`;
  const key = card.agentId
    ? `agent:${sanitizeSessionSegment(card.agentId, "agent")}:${name}`
    : name;
  let sessionKey: string;
  try {
    const existing = params.readSessions
      ? (await params.readSessions({ includeUnknown: false, sessionKey: key })).sessions[0]
      : undefined;
    if (existing && sessionProvesPreparedAcceptance(existing)) {
      sessionKey = existing.key;
    } else {
      // A handoff the full log cut still opens the session, which reads the card instead.
      const log = await store.readNodeGrillLog(worktree);
      const handoff = log === undefined ? undefined : grillHandoffFromLog(log, round);
      // Best effort: without the copy the session still grills from the handoff.
      const branch = await copyGrillBranch(params.runtime, card).catch((error: unknown) => {
        params.warn(
          `workboard: could not copy card ${card.id}'s ticket branch for its grill session: ${formatErrorMessage(error)}`,
        );
        const reason = formatErrorMessage(error).split("\n")[0];
        return { error: capText(reason, MAX_COPY_ERROR_CHARS) ?? "unknown error" };
      });
      sessionKey = await startNodeGrillSession(params.runtime, card, key, handoff, branch);
    }
  } catch (error) {
    await store.block(
      card.id,
      {
        reason: capText(
          `The grill session could not start: ${formatErrorMessage(error)}\nFix the cause, then move the card to todo to try again.`,
          MAX_BLOCK_REASON_CHARS,
        ),
      },
      null,
    );
    return;
  }
  const recorded = await store.setNodeGrillSession(card.id, {
    worktreePath: worktree.path,
    round,
    sessionKey,
  });
  if (!recorded) {
    params.warn(
      `workboard: grill session ${sessionKey} of card ${card.id} was not recorded; the card's grilling changed while it was created`,
    );
  }
}

/**
 * The grilling result when the operator ends it: the grill session's last
 * reply. `replying` while that session runs a turn, so the end waits for it;
 * "" when the grilling has no session yet.
 */
export async function readNodeGrillResult(
  runtime: WorkboardNodeTicketRuntime,
  readSessions: WorkboardLifecycleSessionReader | undefined,
  sessionKey: string | undefined,
): Promise<{ replying: true } | { replying: false; result: string }> {
  if (!sessionKey) {
    return { replying: false, result: "" };
  }
  if (readSessions && (await workboardSessionHasActiveRun(readSessions, sessionKey))) {
    return { replying: true };
  }
  const history = await runtime.request(
    "chat.history",
    { sessionKey, limit: GRILL_HISTORY_LIMIT },
    { scopes: ["operator.read"] },
  );
  const messages = isRecord(history) && Array.isArray(history.messages) ? history.messages : [];
  return { replying: false, result: lastAssistantReply(messages) };
}
