import type {
  WorkboardExecutionTarget,
  WorkboardMergeRegression,
  WorkboardNodeFeedback,
  WorkboardNodeGrill,
  WorkboardNodeHandoff,
  WorkboardNodeQuestions,
  WorkboardNodeReviewVerdict,
  WorkboardNodeRework,
  WorkboardNodeVerification,
  WorkboardNodeWorktree,
  WorkboardVerificationVerdict,
} from "@openclaw/workboard-contract";
import { resolveOptionalIntegerOption } from "openclaw/plugin-sdk/number-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  normalizeNodeRounds,
  normalizeNodeVisualCheck,
  normalizeNodeVisualRead,
  normalizeVerificationFindings,
  visualCheckVerdict,
  visualReadVerdict,
} from "./node-ticket-rounds.js";
import { MAX_NODE_REVIEW_VERDICTS } from "./store-constants.js";
import { normalizeBoundedString, normalizeCommentSource } from "./store-value-normalizers.js";
import { isAbsoluteWorkspacePath, relativeRepoPath } from "./workspace-path.js";

function normalizeNodeHandoff(value: unknown): WorkboardNodeHandoff | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (value.phase === "pending") {
    const reportedAt = resolveOptionalIntegerOption(value.reportedAt, { min: 0 });
    return reportedAt === undefined ? undefined : { phase: "pending", reportedAt };
  }
  if (value.phase === "questions") {
    const askedAt = resolveOptionalIntegerOption(value.askedAt, { min: 0 });
    const reviewFrom = resolveOptionalIntegerOption(value.reviewFrom, { min: 0 });
    const slotWaitNotedAt = resolveOptionalIntegerOption(value.slotWaitNotedAt, { min: 0 });
    const escalatedAt = resolveOptionalIntegerOption(value.escalatedAt, { min: 0 });
    return askedAt === undefined
      ? undefined
      : {
          phase: "questions",
          askedAt,
          ...(reviewFrom !== undefined ? { reviewFrom } : {}),
          ...(slotWaitNotedAt !== undefined ? { slotWaitNotedAt } : {}),
          ...(escalatedAt !== undefined ? { escalatedAt } : {}),
        };
  }
  if (value.phase === "grilling") {
    const askedAt = resolveOptionalIntegerOption(value.askedAt, { min: 0 });
    const slotWaitNotedAt = resolveOptionalIntegerOption(value.slotWaitNotedAt, { min: 0 });
    return askedAt === undefined
      ? undefined
      : {
          phase: "grilling",
          askedAt,
          ...(slotWaitNotedAt !== undefined ? { slotWaitNotedAt } : {}),
        };
  }
  if (value.phase !== "imported" && value.phase !== "published") {
    return undefined;
  }
  const importedAt = resolveOptionalIntegerOption(value.importedAt, { min: 0 });
  const headCommit = normalizeBoundedString(
    value.headCommit,
    undefined,
    64,
    "node handoff head commit",
  );
  if (importedAt === undefined || !headCommit) {
    return undefined;
  }
  if (value.phase === "imported") {
    const decidedBy = normalizeCommentSource(value.decidedBy);
    return {
      phase: "imported",
      headCommit,
      importedAt,
      ...(value.verify === true ? { verify: true as const } : {}),
      ...(value.crossVerify === true ? { crossVerify: true as const } : {}),
      ...(decidedBy && decidedBy !== "operator" ? { decidedBy } : {}),
      ...(typeof value.sampled === "boolean" ? { sampled: value.sampled } : {}),
    };
  }
  const publishedAt = resolveOptionalIntegerOption(value.publishedAt, { min: 0 });
  const pullRequestUrl = normalizeBoundedString(
    value.pullRequestUrl,
    undefined,
    500,
    "node handoff pull request url",
  );
  if (publishedAt === undefined || !pullRequestUrl) {
    return undefined;
  }
  const reviewFrom = resolveOptionalIntegerOption(value.reviewFrom, { min: 0 });
  const slotWaitNotedAt = resolveOptionalIntegerOption(value.slotWaitNotedAt, { min: 0 });
  const pullRequest = normalizePullRequestState(value.pullRequest);
  const conflictReworkAt = resolveOptionalIntegerOption(value.conflictReworkAt, { min: 0 });
  return {
    phase: "published",
    headCommit,
    importedAt,
    publishedAt,
    pullRequestUrl,
    ...(reviewFrom !== undefined ? { reviewFrom } : {}),
    ...(slotWaitNotedAt !== undefined ? { slotWaitNotedAt } : {}),
    ...(pullRequest ? { pullRequest } : {}),
    ...(conflictReworkAt !== undefined ? { conflictReworkAt } : {}),
  };
}

type PullRequestFacts = NonNullable<
  Extract<WorkboardNodeHandoff, { phase: "published" }>["pullRequest"]
>;

function normalizePullRequestState(value: unknown): PullRequestFacts | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const { state } = value;
  const checkedAt = resolveOptionalIntegerOption(value.checkedAt, { min: 0 });
  if (
    checkedAt === undefined ||
    (state !== "open" && state !== "draft" && state !== "merged" && state !== "closed")
  ) {
    return undefined;
  }
  const mergedAt = resolveOptionalIntegerOption(value.mergedAt, { min: 0 });
  const mergeCommit = normalizeBoundedString(value.mergeCommit, undefined, 64, "merge commit");
  const regression = normalizeMergeRegression(value.regression);
  const wait = isRecord(value.autoMergeWait) ? value.autoMergeWait : undefined;
  const waitSince = resolveOptionalIntegerOption(wait?.since, { min: 0 });
  const waitReason = wait?.reason;
  return {
    state,
    checkedAt,
    ...(mergedAt === undefined ? {} : { mergedAt }),
    ...(mergeCommit ? { mergeCommit } : {}),
    ...(regression ? { regression } : {}),
    ...(value.autoMerged === true ? { autoMerged: true as const } : {}),
    ...(waitSince !== undefined &&
    (waitReason === "base_red" ||
      waitReason === "checks_failed" ||
      waitReason === "checks_missing" ||
      waitReason === "head_moved")
      ? { autoMergeWait: { reason: waitReason, since: waitSince } }
      : {}),
  };
}

function normalizeMergeRegression(value: unknown): WorkboardMergeRegression | undefined {
  if (!isRecord(value) || (value.kind !== "revert" && value.kind !== "red_main")) {
    return undefined;
  }
  const at = resolveOptionalIntegerOption(value.at, { min: 0 });
  const commit = normalizeBoundedString(value.commit, undefined, 64, "regression commit");
  const dismissedAt = resolveOptionalIntegerOption(value.dismissedAt, { min: 0 });
  return at !== undefined && commit
    ? {
        kind: value.kind,
        at,
        commit,
        ...(value.demoted === true ? { demoted: true as const } : {}),
        ...(dismissedAt === undefined ? {} : { dismissedAt }),
      }
    : undefined;
}

function normalizeNodeRework(value: unknown): WorkboardNodeRework | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const round = resolveOptionalIntegerOption(value.round, { min: 1 });
  const outsideCommits = resolveOptionalIntegerOption(value.outsideCommits, { min: 0 });
  const acceptedAt = resolveOptionalIntegerOption(value.acceptedAt, { min: 0 });
  const pullRequestUrl = normalizeBoundedString(
    value.pullRequestUrl,
    undefined,
    500,
    "node rework pull request url",
  );
  const startCommit = normalizeBoundedString(
    value.startCommit,
    undefined,
    64,
    "node rework start commit",
  );
  const unchangedRounds = [
    ...new Set(
      (Array.isArray(value.unchangedRounds) ? value.unchangedRounds : []).flatMap(
        (entry) => resolveOptionalIntegerOption(entry, { min: 1 }) ?? [],
      ),
    ),
  ].toSorted((a, b) => a - b);
  return round === undefined ||
    outsideCommits === undefined ||
    acceptedAt === undefined ||
    !pullRequestUrl
    ? undefined
    : {
        round,
        pullRequestUrl,
        acceptedAt,
        outsideCommits,
        ...(startCommit ? { startCommit } : {}),
        ...(unchangedRounds.length > 0 ? { unchangedRounds } : {}),
      };
}

function normalizeNodeQuestions(value: unknown): WorkboardNodeQuestions | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const rounds = resolveOptionalIntegerOption(value.rounds, { min: 1 });
  const operatorAnswers = resolveOptionalIntegerOption(value.operatorAnswers, { min: 0 });
  return rounds === undefined || operatorAnswers === undefined
    ? undefined
    : { rounds, operatorAnswers };
}

function normalizeNodeFeedback(value: unknown): WorkboardNodeFeedback | undefined {
  if (
    !isRecord(value) ||
    (value.kind !== "answer" && value.kind !== "rework" && value.kind !== "grill")
  ) {
    return undefined;
  }
  const from = resolveOptionalIntegerOption(value.from, { min: 0 });
  return from === undefined ? undefined : { kind: value.kind, from };
}

function normalizeNodeGrill(value: unknown): WorkboardNodeGrill | undefined {
  if (!isRecord(value) || (value.status !== "open" && value.status !== "closed")) {
    return undefined;
  }
  const rounds = resolveOptionalIntegerOption(value.rounds, { min: 1 });
  const attachmentId = normalizeBoundedString(
    value.attachmentId,
    undefined,
    200,
    "node grill attachment id",
  );
  if (rounds === undefined || !attachmentId) {
    return undefined;
  }
  const sessionKey = normalizeBoundedString(
    value.sessionKey,
    undefined,
    500,
    "node grill session key",
  );
  const pending = isRecord(value.pending) ? value.pending : undefined;
  const kind = pending?.kind;
  const at = resolveOptionalIntegerOption(pending?.at, { min: 0 });
  return {
    status: value.status,
    rounds,
    attachmentId,
    ...(sessionKey ? { sessionKey } : {}),
    ...(kind === "end" && at !== undefined ? { pending: { kind, at } } : {}),
  };
}

function normalizeNodeReviews(value: unknown): WorkboardNodeReviewVerdict[] {
  return (Array.isArray(value) ? value : [])
    .flatMap((entry): WorkboardNodeReviewVerdict[] => {
      const round = isRecord(entry)
        ? resolveOptionalIntegerOption(entry.round, { min: 0 })
        : undefined;
      const verdict = isRecord(entry) ? entry.verdict : undefined;
      if (
        round === undefined ||
        (verdict !== "accept" && verdict !== "rework" && verdict !== "missed")
      ) {
        return [];
      }
      const importedAt = resolveOptionalIntegerOption(entry.importedAt, { min: 0 });
      const publishedAt = resolveOptionalIntegerOption(entry.publishedAt, { min: 0 });
      const readAt = resolveOptionalIntegerOption(entry.readAt, { min: 0 });
      const verdictAt = resolveOptionalIntegerOption(entry.verdictAt, { min: 0 });
      const verification = isRecord(entry.verification)
        ? verificationVerdict(entry.verification.verdict)
        : undefined;
      const visual = isRecord(entry.verification)
        ? reviewVisual(entry.verification.visual)
        : undefined;
      const crossVerification = isRecord(entry.crossVerification)
        ? verificationVerdict(entry.crossVerification.verdict)
        : undefined;
      return [
        {
          round,
          verdict,
          ...(importedAt === undefined ? {} : { importedAt }),
          ...(publishedAt === undefined ? {} : { publishedAt }),
          ...(entry.decidedBy === "agent" ? { decidedBy: "agent" as const } : {}),
          ...(typeof entry.sampled === "boolean" ? { sampled: entry.sampled } : {}),
          ...(readAt === undefined ? {} : { readAt }),
          ...(verdictAt === undefined ? {} : { verdictAt }),
          ...(entry.rung === "b" || entry.rung === "c" ? { rung: entry.rung } : {}),
          ...(verification && isRecord(entry.verification)
            ? {
                verification: {
                  verdict: verification,
                  ...verificationModel(entry.verification.model),
                  ...verificationSpan(entry.verification),
                  ...(visual ? { visual } : {}),
                },
              }
            : {}),
          ...(crossVerification && isRecord(entry.crossVerification)
            ? {
                crossVerification: {
                  verdict: crossVerification,
                  ...verificationModel(entry.crossVerification.model),
                  ...verificationSpan(entry.crossVerification),
                },
              }
            : {}),
        },
      ];
    })
    .slice(-MAX_NODE_REVIEW_VERDICTS);
}

function reviewVisual(
  value: unknown,
): NonNullable<WorkboardNodeReviewVerdict["verification"]>["visual"] {
  const verifier = isRecord(value) ? visualReadVerdict(value.verifier) : undefined;
  const operator = isRecord(value) ? visualCheckVerdict(value.operator) : undefined;
  return verifier && operator ? { verifier, operator } : undefined;
}

function verificationVerdict(value: unknown): WorkboardVerificationVerdict | undefined {
  return value === "pass" || value === "fail" || value === "error" ? value : undefined;
}

function verificationSpan(value: Record<string, unknown>): {
  startedAt?: number;
  endedAt?: number;
} {
  const startedAt = resolveOptionalIntegerOption(value.startedAt, { min: 0 });
  const endedAt = resolveOptionalIntegerOption(value.endedAt, { min: 0 });
  return startedAt === undefined
    ? {}
    : { startedAt, ...(endedAt === undefined ? {} : { endedAt }) };
}

function verificationModel(value: unknown): { model?: string } {
  const model = normalizeBoundedString(value, undefined, 160, "node verification model");
  return model ? { model } : {};
}

const MAX_VERIFICATION_SUMMARY_CHARS = 2000;

function normalizeNodeVerification(value: unknown): WorkboardNodeVerification | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const round = resolveOptionalIntegerOption(value.round, { min: 0 });
  const headCommit = normalizeBoundedString(
    value.headCommit,
    undefined,
    64,
    "node verification head commit",
  );
  const startedAt = resolveOptionalIntegerOption(value.startedAt, { min: 0 });
  const sessionKey = normalizeBoundedString(
    value.sessionKey,
    undefined,
    500,
    "node verification session key",
  );
  if (round === undefined || !headCommit || startedAt === undefined) {
    return undefined;
  }
  const model = verificationModel(value.model);
  if (value.phase === "running") {
    const path = normalizeBoundedString(value.path, undefined, 2000, "node verification path");
    return sessionKey && path
      ? { phase: "running", round, headCommit, startedAt, sessionKey, path, ...model }
      : undefined;
  }
  const endedAt = resolveOptionalIntegerOption(value.endedAt, { min: 0 });
  const verdict = verificationVerdict(value.verdict);
  if (value.phase !== "done" || endedAt === undefined || !verdict) {
    return undefined;
  }
  const visualCheck = normalizeNodeVisualCheck(value.visualCheck);
  return {
    phase: "done",
    round,
    headCommit,
    startedAt,
    endedAt,
    ...(sessionKey ? { sessionKey } : {}),
    ...model,
    verdict,
    summary:
      normalizeBoundedString(
        value.summary,
        undefined,
        MAX_VERIFICATION_SUMMARY_CHARS,
        "node verification summary",
      ) ?? "",
    findings: normalizeVerificationFindings(value.findings),
    ...(value.visual === undefined ? {} : { visual: normalizeNodeVisualRead(value.visual) }),
    ...(visualCheck ? { visualCheck } : {}),
  };
}

function normalizeNodeWorktree(value: unknown): WorkboardNodeWorktree | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const worktreePath = normalizeBoundedString(value.path, undefined, 2000, "node worktree path");
  const branch = normalizeBoundedString(value.branch, undefined, 160, "node worktree branch");
  const baseCommit = normalizeBoundedString(
    value.baseCommit,
    undefined,
    64,
    "node worktree base commit",
  );
  const handoff = normalizeNodeHandoff(value.handoff);
  const rework = normalizeNodeRework(value.rework);
  const questions = normalizeNodeQuestions(value.questions);
  const feedback = normalizeNodeFeedback(value.feedback);
  const grill = normalizeNodeGrill(value.grill);
  const reviews = normalizeNodeReviews(value.reviews);
  const rounds = normalizeNodeRounds(value.rounds);
  const verification = normalizeNodeVerification(value.verification);
  const crossVerification = normalizeNodeVerification(value.crossVerification);
  const stopRequestedAt = resolveOptionalIntegerOption(value.stopRequestedAt, { min: 0 });
  return worktreePath && branch && baseCommit
    ? {
        path: worktreePath,
        branch,
        baseCommit,
        ...(handoff ? { handoff } : {}),
        ...(rework ? { rework } : {}),
        ...(questions ? { questions } : {}),
        ...(feedback ? { feedback } : {}),
        ...(grill ? { grill } : {}),
        ...(reviews.length > 0 ? { reviews } : {}),
        ...(rounds.length > 0 ? { rounds } : {}),
        ...(verification ? { verification } : {}),
        ...(crossVerification ? { crossVerification } : {}),
        ...(value.rung === "b" || value.rung === "c" ? { rung: value.rung } : {}),
        ...(stopRequestedAt !== undefined ? { stopRequestedAt } : {}),
      }
    : undefined;
}

export type WorkboardNodeHandoffInput = {
  worktreePath: string;
  /** Absent clears the handoff: a report-only round left nothing to import. */
  handoff?: WorkboardNodeHandoff;
  /** The shadow verdict on the round a publish closes; appended to the worktree's reviews. */
  review?: WorkboardNodeReviewVerdict;
  /** A done report's headline; replaces the card's `automation.summary` in the same write. */
  summary?: string;
  /** The imported rework round added no commit besides merges; recorded in `rework.unchangedRounds`. */
  reworkUnchanged?: true;
};

export function withNodeHandoff(
  worktree: WorkboardNodeWorktree,
  input: WorkboardNodeHandoffInput,
): WorkboardNodeWorktree {
  const reviews = input.review
    ? [...(worktree.reviews ?? []), input.review].slice(-MAX_NODE_REVIEW_VERDICTS)
    : worktree.reviews;
  const rework = worktree.rework;
  const unchanged =
    input.reworkUnchanged && rework && !rework.unchangedRounds?.includes(rework.round)
      ? { ...rework, unchangedRounds: [...(rework.unchangedRounds ?? []), rework.round] }
      : rework;
  const { handoff: _replaced, ...kept } = worktree;
  return {
    ...kept,
    ...(input.handoff ? { handoff: input.handoff } : {}),
    ...(unchanged ? { rework: unchanged } : {}),
    ...(reviews ? { reviews } : {}),
  };
}

const MAX_SCREENSHOT_DIRS = 8;
const MAX_SCREENSHOT_DIR_LENGTH = 200;

/** Worktree-relative dirs only: live reads must stay inside the card's worktree. */
function normalizeScreenshotDirs(value: unknown): string[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SCREENSHOT_DIRS) {
    throw new Error(
      `target screenshotDirs must be an array of 1 to ${MAX_SCREENSHOT_DIRS} worktree-relative dirs.`,
    );
  }
  const dirs = new Set<string>();
  for (const entry of value) {
    const dir = relativeRepoPath(entry);
    if (!dir || dir.length > MAX_SCREENSHOT_DIR_LENGTH) {
      throw new Error(
        `target screenshotDirs entry ${JSON.stringify(entry)} must be a relative path inside the worktree, without "." or ".." segments.`,
      );
    }
    dirs.add(dir);
  }
  return [...dirs];
}

/** The recorded worktree is dispatcher state; raw input can only keep it for the same target. */
export function normalizeExecutionTarget(
  value: unknown,
  fallback?: WorkboardExecutionTarget,
  options: { allowLaunchState?: boolean } = {},
): WorkboardExecutionTarget | undefined {
  if (value === null) {
    return undefined;
  }
  if (!isRecord(value)) {
    return fallback;
  }
  if (value.kind !== "node-claude") {
    throw new Error("execution target kind must be node-claude.");
  }
  const nodeId = normalizeBoundedString(value.nodeId, undefined, 200, "target node id");
  const repoPath = normalizeBoundedString(value.repoPath, undefined, 2000, "target repo path");
  const worktreesRoot = normalizeBoundedString(
    value.worktreesRoot,
    undefined,
    2000,
    "target worktrees root",
  );
  const hostRepoPath = normalizeBoundedString(
    value.hostRepoPath,
    undefined,
    2000,
    "target host repo path",
  );
  if (!nodeId || !repoPath || !worktreesRoot || !hostRepoPath) {
    throw new Error("node-claude target needs nodeId, repoPath, worktreesRoot, and hostRepoPath.");
  }
  if (
    !isAbsoluteWorkspacePath(repoPath) ||
    !isAbsoluteWorkspacePath(worktreesRoot) ||
    !isAbsoluteWorkspacePath(hostRepoPath)
  ) {
    throw new Error("node-claude target paths must be absolute.");
  }
  const baseRef = normalizeBoundedString(value.baseRef, undefined, 160, "target base ref");
  const model = normalizeBoundedString(value.model, undefined, 160, "target model");
  const screenshotDirs = normalizeScreenshotDirs(value.screenshotDirs);
  const sameTarget =
    fallback?.nodeId === nodeId &&
    fallback.repoPath === repoPath &&
    fallback.worktreesRoot === worktreesRoot;
  const worktree = options.allowLaunchState
    ? normalizeNodeWorktree(value.worktree)
    : sameTarget
      ? fallback.worktree
      : undefined;
  return {
    kind: "node-claude",
    nodeId,
    repoPath,
    worktreesRoot,
    hostRepoPath,
    ...(baseRef ? { baseRef } : {}),
    ...(model ? { model } : {}),
    ...(screenshotDirs ? { screenshotDirs } : {}),
    ...(worktree ? { worktree } : {}),
  };
}
