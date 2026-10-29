import path from "node:path";
import type {
  WorkboardCard,
  WorkboardExecutionTarget,
  WorkboardNodeVerification,
  WorkboardNodeVerificationFinding,
  WorkboardNodeVisualRead,
  WorkboardNodeWorktree,
  WorkboardVerificationVerdict,
  WorkboardVerifierSettings,
} from "@openclaw/workboard-contract";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { WorkboardLifecycleSessionReader } from "./lifecycle-sync.js";
import { lastAssistantReply } from "./node-ticket-report.js";
import { normalizeNodeVisualRead, normalizeVerificationFindings } from "./node-ticket-rounds.js";
import {
  isVerificationComment,
  nodeTicketTarget,
  runNodeCommand,
  sessionCreateRunError,
  type WorkboardNodeTicketRuntime,
} from "./node-ticket.js";
import { currentNodeVerification, type ImportedHandoff } from "./review-readiness.js";
import { sanitizeSessionSegment, workboardSessionHasActiveRun } from "./session-link.js";
import { MAX_COMMENT_BODY_CHARS } from "./store-constants.js";
import { capText } from "./store-normalizers.js";
import type { WorkboardStore } from "./store.js";

/** The fence of the block that ends a verifier session's final message. */
export const VERIFICATION_FENCE = "workboard-verification";
const VERIFICATION_PATTERN = new RegExp(
  "```" + VERIFICATION_FENCE + "\\s*\\n([\\s\\S]*?)\\n```",
  "g",
);
const VERIFICATION_SESSION_GROUP = "Verification";
// The verifier's last messages hold its last reply; earlier ones are not read.
const VERIFICATION_HISTORY_LIMIT = 20;
const MAX_VERIFICATION_SUMMARY_CHARS = 2000;
// The record's own write wakes the sweep at once, possibly before the session
// view lists the new run; until a reply exists, a young session is starting.
const VERIFICATION_START_GRACE_MS = 2 * 60_000;

/** A node ticket waiting in review on its imported round: where a verification starts. */
type ImportedReviewRound = {
  target: WorkboardExecutionTarget & { kind: "node-claude" };
  worktree: WorkboardNodeWorktree;
  handoff: ImportedHandoff;
  round: number;
};

function importedReviewRound(card: WorkboardCard): ImportedReviewRound | undefined {
  const target = nodeTicketTarget(card);
  const worktree = target?.worktree;
  const handoff = worktree?.handoff;
  if (
    !target ||
    !worktree ||
    handoff?.phase !== "imported" ||
    card.status !== "review" ||
    card.metadata?.archivedAt
  ) {
    return undefined;
  }
  return { target, worktree, handoff, round: worktree.rework?.round ?? 0 };
}

/**
 * A node ticket whose worktree record carries a running verification. The
 * verifier session runs on the node whatever the card's status, so it settles
 * after the operator decided the round, archived the card, or a rework round
 * launched, and whether or not the record is the imported round's.
 */
type RunningVerification = {
  target: ImportedReviewRound["target"];
  worktree: WorkboardNodeWorktree;
  verification: Extract<WorkboardNodeVerification, { phase: "running" }>;
};

function runningNodeVerification(card: WorkboardCard): RunningVerification | undefined {
  const target = nodeTicketTarget(card);
  const worktree = target?.worktree;
  const verification = worktree?.verification;
  return target && worktree && verification?.phase === "running"
    ? { target, worktree, verification }
    : undefined;
}

export type NodeVerificationStep =
  | { kind: "start"; round: ImportedReviewRound; verifier: WorkboardVerifierSettings }
  | ({ kind: "settle" } & RunningVerification);

/**
 * What the handoff pass owes a card's verification: settle the one that runs,
 * in any card status, or start one when the board has a verifier and the
 * imported round in review has none yet. The board is read only for a round
 * that could start one, so a sweep over the board's cards costs no lookup per
 * card. A running record settles even after the operator removed the verifier.
 */
export async function nodeVerificationStep(
  card: WorkboardCard,
  verifierOf: () => Promise<WorkboardVerifierSettings | undefined>,
): Promise<NodeVerificationStep | undefined> {
  const running = runningNodeVerification(card);
  if (running) {
    return { kind: "settle", ...running };
  }
  const round = importedReviewRound(card);
  if (!round || currentNodeVerification(round.worktree, round.handoff)) {
    return undefined;
  }
  const verifier = await verifierOf();
  return verifier ? { kind: "start", round, verifier } : undefined;
}

/** The card's verify worktree name for a round: `verify-<card8>-r<round>`. */
function verificationName(card: WorkboardCard, round: number): string {
  return `verify-${sanitizeSessionSegment(card.id.slice(0, 8), "card")}-r${round}`;
}

/**
 * The session key of the round's next verification run: `agent:<agentId>:
 * verify-<card8>-r<round>-v<n>`, where `n` counts the verification comments
 * the round's earlier runs posted. Each run gets a fresh session, so a re-run
 * never settles on a previous reply. The count is durable: a crash between
 * create and record computes the same key and adopts the session it created.
 */
function verificationSessionKey(
  card: WorkboardCard,
  round: ImportedReviewRound,
  verifier: WorkboardVerifierSettings,
): string {
  const runs = (card.metadata?.comments ?? []).filter(
    (comment) => comment.createdAt >= round.handoff.importedAt && isVerificationComment(comment),
  ).length;
  const agent = sanitizeSessionSegment(verifier.agentId, "agent");
  return `agent:${agent}:${verificationName(card, round.round)}-v${runs}`;
}

export function verificationMessage(params: {
  card: WorkboardCard;
  round: ImportedReviewRound;
  verifyPath: string;
}): string {
  const { card, verifyPath } = params;
  const { target, worktree, handoff, round } = params.round;
  const head = handoff.headCommit;
  // The round's own commits, the range the import checked; a rework round's
  // earlier rounds are already on the PR branch.
  const from = worktree.rework?.startCommit ?? worktree.baseCommit;
  const notes = card.notes?.trim();
  return [
    `Verify this Workboard ticket's imported round: ${card.title} (card \`${card.id}\`, round ${round})`,
    "",
    "You did not write this change; another session did. Judge the artifact, not its author's account of it.",
    "",
    "## Where",
    `- Node ${target.nodeId}. Your working directory is the detached worktree \`${verifyPath}\` at commit \`${head}\`, the round's imported head. Stay inside it.`,
    `- The round's range is \`${from}..${head}\`: \`git log --oneline ${from}..${head}\` lists its commits, \`git diff ${from}..${head}\` its changes.`,
    "- Ticket sessions build on this node while you verify. Where a proof command names a build cache outside this worktree (such as `xcodebuild -derivedDataPath <dir>`), use `<dir>-verify` instead: the shared one is locked by their builds, and yours stays warm across verifications.",
    `- Where a proof command runs on a named simulator (such as \`xcodebuild -destination 'platform=iOS Simulator,name=<device>'\`), ticket sessions test on that simulator too, and a test run on it while theirs runs gets killed or stalls. Create your own instead: \`xcrun simctl create ${verificationName(card, round)} "<device>"\` prints its udid; boot it with \`xcrun simctl boot <udid>\` and \`xcrun simctl bootstatus <udid> -b\`, and use \`id=<udid>\` in place of \`name=<device>\`. Run \`xcrun simctl delete <udid>\` before your reply, also when the proof failed, so its caches go with it.`,
    ...(from !== worktree.baseCommit
      ? [
          `- This is rework round ${round}; the whole ticket since its base is \`${worktree.baseCommit}..${head}\`.`,
        ]
      : []),
    "",
    "## The ticket",
    ...(notes
      ? ["The card's notes are the spec. Their Proof section names the proof to re-run.", "", notes]
      : ["The card has no notes; the commit messages and the diff are the spec."]),
    "",
    "## What to do",
    "1. Re-run the proof the notes name from this worktree and note what each command printed.",
    "2. Then try to break the change: check each acceptance criterion with a `file:line` or a command that shows it; try the sibling entry points of what changed; async, cancel, and restart state; the boundaries against the other side of each interface; and drift between the code and its docs or ADRs.",
    "3. Throwaway probe tests and scratch files are fine inside this worktree. Never commit, push, or touch other worktrees or branches.",
    "4. A proof the notes mark `Operator-run` is not a failure when you cannot run it. A style preference is not a failure.",
    "5. Judge each failure you find against the failure scope: the notes' `Failure scope:` line, or else one fault at a time, a client cancellation, or a restart. A failure that needs two simultaneous faults, or a destructive admin operation (a reset, wipe, or delete) racing the operation under test, is beyond scope and not a finding: name it in the summary under `Beyond scope:` with a proposed follow-up card.",
    "",
    "## Screenshots",
    'When the proof captures screenshots (the project\'s skill says where), look at each one. In one `exec` script, downscale each PNG to a JPEG no wider than 800 px (`sips -Z 800 -s format jpeg -s formatOptions 65 in.png --out out.jpg` through your node exec tool), base64 it (`base64 -i out.jpg`), and call `image("data:image/jpeg;base64,<base64>")` in the script so the images come back to you as image blocks. Never send a full-size PNG.',
    "Record what you saw in the block's `visual` part: per screenshot its path, what it shows (the selected tab, the text, which button is filled, any alert, whether dark mode changed the colors), and `looks_right` or `problem`, plus the overall visual verdict. The visual check is operator-run: it never makes your verdict `fail` or `error`. A round without screenshots, or a session that cannot show itself an image, records `not_checked`, not `error`.",
    "",
    "End your final message with exactly one block:",
    "",
    "```" + VERIFICATION_FENCE,
    '{"verdict":"pass|fail|error","summary":"what you ran and what you found, in plain words","findings":[{"path":"repo/relative/file","line":1,"body":"what is wrong and how you showed it"}],"visual":{"verdict":"looks_right|problem|not_checked","screenshots":[{"path":"path/to/screenshot.png","shows":"what is on screen","verdict":"looks_right|problem"}]}}',
    "```",
    "",
    "`fail` needs at least one in-scope finding that names a defect. `pass` means the proof re-ran and nothing you tried broke the change. `error` means you could not finish the proof (the node went away, a tool or simulator kept failing) and found no defect; the summary says what ran and what stopped you, and the operator re-runs the verification. At most 12 findings and 12 screenshots are kept; `line` may be left out when a finding has no line.",
  ].join("\n");
}

type ParsedVerification = {
  verdict: WorkboardVerificationVerdict;
  summary: string;
  findings: WorkboardNodeVerificationFinding[];
  visual: WorkboardNodeVisualRead;
};

/**
 * Reads the one verification block of the verifier's last reply; anything
 * else is an `error` verdict. The visual read never changes the verdict.
 */
export function parseVerificationReply(text: string): ParsedVerification {
  const error = (summary: string): ParsedVerification => ({
    verdict: "error",
    summary,
    findings: [],
    visual: normalizeNodeVisualRead(undefined),
  });
  const blocks = [...text.matchAll(VERIFICATION_PATTERN)];
  if (blocks.length !== 1) {
    return error(
      blocks.length === 0
        ? `The verifier's last reply has no ${VERIFICATION_FENCE} block.`
        : `The verifier's last reply has ${blocks.length} ${VERIFICATION_FENCE} blocks; exactly one is expected.`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(blocks[0]?.[1] ?? "");
  } catch (parseError) {
    return error(
      `The verifier's ${VERIFICATION_FENCE} block is not valid JSON: ${formatErrorMessage(parseError)}.`,
    );
  }
  if (
    !isRecord(value) ||
    (value.verdict !== "pass" && value.verdict !== "fail" && value.verdict !== "error")
  ) {
    return error(
      `The verifier's ${VERIFICATION_FENCE} block needs a verdict of pass, fail, or error.`,
    );
  }
  return {
    verdict: value.verdict,
    summary:
      typeof value.summary === "string"
        ? (capText(value.summary.trim(), MAX_VERIFICATION_SUMMARY_CHARS) ?? "")
        : "",
    // An unfinished proof names no defect, so it carries no findings.
    findings: value.verdict === "error" ? [] : normalizeVerificationFindings(value.findings),
    visual: normalizeNodeVisualRead(value.visual),
  };
}

/**
 * A detached worktree of the imported head in the node clone. The import
 * removed the ticket worktree and branch, so the head is reachable only from
 * here; a clone whose `gc` pruned it meanwhile fails the add, and the run
 * records that as an error for the operator to re-run.
 */
async function prepareVerifyWorktree(
  runtime: WorkboardNodeTicketRuntime,
  target: ImportedReviewRound["target"],
  verifyPath: string,
  headCommit: string,
): Promise<void> {
  const current = await runNodeCommand(runtime, target.nodeId, [
    "git",
    "-C",
    verifyPath,
    "rev-parse",
    "HEAD",
  ]).catch(() => undefined);
  if (current === headCommit) {
    return;
  }
  const git = (...args: string[]) =>
    runNodeCommand(runtime, target.nodeId, ["git", "-C", target.repoPath, ...args]);
  if (current !== undefined) {
    await git("worktree", "remove", "--force", verifyPath);
  }
  await git("worktree", "add", "--detach", verifyPath, headCommit);
}

async function createVerificationSession(params: {
  runtime: WorkboardNodeTicketRuntime;
  card: WorkboardCard;
  round: ImportedReviewRound;
  verifier: WorkboardVerifierSettings;
  key: string;
  verifyPath: string;
}): Promise<{ sessionKey: string; model?: string }> {
  const { card, round, verifier, key, verifyPath } = params;
  const result = await params.runtime.request(
    "sessions.create",
    {
      key,
      agentId: verifier.agentId,
      model: verifier.model,
      // Binds the session's exec host to the node: its shell commands run in the verify worktree.
      execNode: round.target.nodeId,
      cwd: verifyPath,
      displayName: `Verify ${card.title}`.slice(0, 120),
      category: VERIFICATION_SESSION_GROUP,
      message: verificationMessage({ card, round, verifyPath }),
    },
    { scopes: ["operator.admin"] },
  );
  const record = isRecord(result) ? result : {};
  if (record.runStarted === false) {
    throw new Error(sessionCreateRunError(record));
  }
  const resolved = isRecord(record.resolved) ? record.resolved : {};
  return {
    sessionKey: typeof record.key === "string" && record.key ? record.key : key,
    ...(typeof resolved.modelProvider === "string" && typeof resolved.model === "string"
      ? { model: `${resolved.modelProvider}/${resolved.model}` }
      : {}),
  };
}

function verificationComment(
  verification: Extract<WorkboardNodeVerification, { phase: "done" }>,
): string {
  const findings = verification.findings.map(
    (finding) =>
      `- \`${finding.path}${finding.line === undefined ? "" : `:${finding.line}`}\` ${finding.body}`,
  );
  return (
    capText(
      [
        `**Verification:** ${verification.verdict}${verification.model ? ` (${verification.model})` : ""}`,
        ...(verification.summary ? ["", verification.summary] : []),
        ...(findings.length > 0 ? ["", ...findings] : []),
      ].join("\n"),
      MAX_COMMENT_BODY_CHARS,
    ) ?? ""
  );
}

/** The agent the verify session key names, `agent:<agentId>:verify-...`; the comment's source. */
function verifierSource(sessionKey: string): `agent:${string}` {
  return `agent:${sessionKey.split(":")[1] ?? "verifier"}`;
}

type NodeVerificationParams = {
  store: WorkboardStore;
  runtime: WorkboardNodeTicketRuntime;
  readSessions: WorkboardLifecycleSessionReader | undefined;
  card: WorkboardCard;
  now: () => number;
  warn: (message: string) => void;
};

/**
 * Records the finished verification, removes its worktree, and posts its
 * comment. The record is what the accept gate reads, so it is written first;
 * a failed comment or removal only warns. Returns false when the card's
 * worktree changed meanwhile and the record found no home.
 */
async function finishNodeVerification(
  params: NodeVerificationParams,
  place: Pick<RunningVerification, "target" | "worktree">,
  verification: Extract<WorkboardNodeVerification, { phase: "done" }>,
  verifyPath: string | undefined,
): Promise<boolean> {
  const { store, card } = params;
  // Accepted edge: a crash between this write and the comment below loses the
  // comment; the review cron's schedule is the nudge backstop.
  const recorded = await store.setNodeVerification(card.id, {
    worktreePath: place.worktree.path,
    verification,
  });
  if (!recorded) {
    params.warn(
      `workboard: verification of card ${card.id} round ${verification.round} was not recorded; its worktree changed while it ran`,
    );
    return false;
  }
  if (verifyPath) {
    await runNodeCommand(params.runtime, place.target.nodeId, [
      "git",
      "-C",
      place.target.repoPath,
      "worktree",
      "remove",
      "--force",
      verifyPath,
    ]).catch((error: unknown) =>
      params.warn(
        `workboard: could not remove the verify worktree ${verifyPath} of card ${card.id}: ${formatErrorMessage(error)}`,
      ),
    );
  }
  const source = verification.sessionKey ? verifierSource(verification.sessionKey) : undefined;
  await store
    .addComment(card.id, { body: verificationComment(verification) }, undefined, source)
    .catch((error: unknown) =>
      params.warn(
        `workboard: could not post the verification comment of card ${card.id}: ${formatErrorMessage(error)}`,
      ),
    );
  return true;
}

/**
 * Opens the verification of an imported round: a detached worktree of its
 * head on the node and a session of the board's verifier agent, on its model,
 * with the node as exec host and the worktree as working directory. A pass
 * after a create whose record was lost adopts the session under the same key
 * while it still runs, instead of sending the brief again. A worktree or
 * create failure ends the verification with an `error` verdict so the card is
 * not held, and removes the worktree the failed start had already added.
 */
async function startNodeVerification(
  params: NodeVerificationParams,
  step: Extract<NodeVerificationStep, { kind: "start" }>,
): Promise<"running" | "done"> {
  const { card } = params;
  const { round, verifier } = step;
  const key = verificationSessionKey(card, round, verifier);
  const verifyPath = path.posix.join(
    round.target.worktreesRoot,
    verificationName(card, round.round),
  );
  const startedAt = params.now();
  const facts = { round: round.round, headCommit: round.handoff.headCommit, startedAt };
  let session: { sessionKey: string; model?: string };
  let prepared = false;
  try {
    const existing = params.readSessions
      ? (await params.readSessions({ includeUnknown: false, sessionKey: key })).sessions[0]
      : undefined;
    if (existing?.hasActiveRun === true) {
      session = { sessionKey: existing.key };
    } else {
      await prepareVerifyWorktree(
        params.runtime,
        round.target,
        verifyPath,
        round.handoff.headCommit,
      );
      prepared = true;
      session = await createVerificationSession({
        runtime: params.runtime,
        card,
        round,
        verifier,
        key,
        verifyPath,
      });
    }
  } catch (error) {
    await finishNodeVerification(
      params,
      round,
      {
        phase: "done",
        ...facts,
        endedAt: params.now(),
        model: verifier.model,
        verdict: "error",
        summary: `The verification could not start: ${formatErrorMessage(error)}`,
        findings: [],
      },
      prepared ? verifyPath : undefined,
    );
    return "done";
  }
  const recorded = await params.store.setNodeVerification(card.id, {
    worktreePath: round.worktree.path,
    verification: {
      phase: "running",
      ...facts,
      sessionKey: session.sessionKey,
      path: verifyPath,
      model: session.model ?? verifier.model,
    },
  });
  if (!recorded) {
    params.warn(
      `workboard: verification session ${session.sessionKey} of card ${card.id} was not recorded; the card's worktree changed while it was created`,
    );
  }
  return "running";
}

/**
 * Settles a running verification once its session has no active run: its
 * last reply's block is the result, and a missing or invalid block is an
 * `error` verdict.
 */
async function settleNodeVerification(
  params: NodeVerificationParams,
  step: Extract<NodeVerificationStep, { kind: "settle" }>,
): Promise<"running" | "done"> {
  const { verification } = step;
  if (
    params.readSessions &&
    (await workboardSessionHasActiveRun(params.readSessions, verification.sessionKey))
  ) {
    return "running";
  }
  const history = await params.runtime.request(
    "chat.history",
    { sessionKey: verification.sessionKey, limit: VERIFICATION_HISTORY_LIMIT },
    { scopes: ["operator.read"] },
  );
  const messages = isRecord(history) && Array.isArray(history.messages) ? history.messages : [];
  const reply = lastAssistantReply(messages);
  if (!reply.trim() && params.now() - verification.startedAt < VERIFICATION_START_GRACE_MS) {
    return "running";
  }
  const { path: verifyPath, ...running } = verification;
  await finishNodeVerification(
    params,
    step,
    {
      ...running,
      phase: "done",
      endedAt: params.now(),
      ...parseVerificationReply(reply),
    },
    verifyPath,
  );
  return "done";
}

/** Runs the card's verification step; `done` means the round's verification just finished. */
export async function runNodeVerification(
  params: NodeVerificationParams,
  step: NodeVerificationStep,
): Promise<"running" | "done"> {
  return step.kind === "start"
    ? await startNodeVerification(params, step)
    : await settleNodeVerification(params, step);
}
