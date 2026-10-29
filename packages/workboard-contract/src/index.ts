import type { WorkboardProbe } from "./probes.js";
import type { WorkboardSessionsBoardSpec } from "./sessions-board.js";
import type { WorkboardTrustWeek } from "./trust.js";
import type {
  WorkboardNodeVerification,
  WorkboardNodeVisualCheck,
  WorkboardNodeVisualRead,
  WorkboardVerificationVerdict,
  WorkboardVerifierSettings,
  WorkboardVisualVerdict,
} from "./verification.js";

export type * from "./verification.js";

export type WorkboardDatabasePortApi<Database, Input> = {
  inspectWorkboardPortSource(db: Database): {
    version: number;
    migrationRequired: boolean;
    pendingColumns: Record<string, string[]>;
  };
  admitWorkboardPort(dbPath: string, input?: Input): void;
  WorkboardPortSchemaError: new (message?: string) => Error;
};

export const WORKBOARD_STATUSES = [
  "triage",
  "backlog",
  "todo",
  "scheduled",
  "ready",
  "running",
  "review",
  "blocked",
  "done",
] as const;

export const WORKBOARD_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
/** Built-in launch choices. Persisted execution engines remain an open runtime identifier. */
export const WORKBOARD_EXECUTION_ENGINES = ["codex", "claude"] as const;
export const WORKBOARD_EXECUTION_MODES = ["autonomous", "manual"] as const;
export const WORKBOARD_EXECUTION_STATUSES = [
  "idle",
  "running",
  "review",
  "blocked",
  "done",
] as const;
export const WORKBOARD_EVENT_KINDS = [
  "created",
  "edited",
  "moved",
  "linked",
  "specified",
  "decomposed",
  "claimed",
  "heartbeat",
  "execution_updated",
  "attempt_started",
  "attempt_updated",
  "comment_added",
  "link_added",
  "proof_added",
  "artifact_added",
  "attachment_added",
  "diagnostic",
  "notification",
  "dispatch",
  "orchestration",
  "protocol_violation",
  "archived",
  "unarchived",
  "stale",
] as const;
export const WORKBOARD_ATTEMPT_STATUSES = [
  "running",
  "succeeded",
  "failed",
  "blocked",
  "stopped",
] as const;
export const WORKBOARD_LINK_TYPES = [
  "parent",
  "child",
  "blocks",
  "blocked_by",
  "relates_to",
] as const;
export const WORKBOARD_PROOF_STATUSES = ["passed", "failed", "skipped", "unknown"] as const;
export const WORKBOARD_TEMPLATE_IDS = ["bugfix", "docs", "release", "pr_review", "plugin"] as const;
export const WORKBOARD_DIAGNOSTIC_KINDS = [
  "stranded_ready",
  "running_without_heartbeat",
  "blocked_too_long",
  "repeated_failures",
  "missing_proof",
  "orphaned_session",
  "archived_but_active",
] as const;
export const WORKBOARD_DIAGNOSTIC_SEVERITIES = ["warning", "error", "critical"] as const;
export const WORKBOARD_NOTIFICATION_KINDS = ["completed", "failed", "stale"] as const;
export const WORKBOARD_BOARD_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,79}$/;

export function isValidWorkboardBoardId(value: unknown): value is string {
  return typeof value === "string" && WORKBOARD_BOARD_ID_PATTERN.test(value);
}

export type WorkboardDeleteResult = {
  deleted: boolean;
  referenceUpdates?: Array<{ id: string; previousUpdatedAt: number; updatedAt: number }>;
};

export type WorkboardStatus = (typeof WORKBOARD_STATUSES)[number];
export type WorkboardPriority = (typeof WORKBOARD_PRIORITIES)[number];
export type WorkboardExecutionEngine = string;
export type WorkboardExecutionMode = (typeof WORKBOARD_EXECUTION_MODES)[number];
export type WorkboardExecutionStatus = (typeof WORKBOARD_EXECUTION_STATUSES)[number];
export type WorkboardEventKind = (typeof WORKBOARD_EVENT_KINDS)[number];
export type WorkboardAttemptStatus = (typeof WORKBOARD_ATTEMPT_STATUSES)[number];
export type WorkboardLinkType = (typeof WORKBOARD_LINK_TYPES)[number];
export type WorkboardProofStatus = (typeof WORKBOARD_PROOF_STATUSES)[number];
export type WorkboardTemplateId = (typeof WORKBOARD_TEMPLATE_IDS)[number];
export type WorkboardDiagnosticKind = (typeof WORKBOARD_DIAGNOSTIC_KINDS)[number];
export type WorkboardDiagnosticSeverity = (typeof WORKBOARD_DIAGNOSTIC_SEVERITIES)[number];
export type WorkboardNotificationKind = (typeof WORKBOARD_NOTIFICATION_KINDS)[number];

export type WorkboardExecution = {
  id: string;
  kind: "agent-session";
  engine?: WorkboardExecutionEngine;
  mode: WorkboardExecutionMode;
  status: WorkboardExecutionStatus;
  model?: string;
  sessionKey?: string;
  runId?: string;
  startedAt: number;
  updatedAt: number;
};

export type WorkboardEvent = {
  id: string;
  kind: WorkboardEventKind;
  at: number;
  fromStatus?: WorkboardStatus;
  toStatus?: WorkboardStatus;
  sessionKey?: string;
  runId?: string;
};

export type WorkboardRunAttempt = {
  id: string;
  status: WorkboardAttemptStatus;
  startedAt: number;
  endedAt?: number;
  engine?: WorkboardExecutionEngine;
  mode?: WorkboardExecutionMode;
  model?: string;
  sessionKey?: string;
  runId?: string;
  error?: string;
  /**
   * Context use at the run's end (draft D16): the prompt tokens of its last
   * model call, from the usage its agent_end messages reported. Absent when the
   * run never replied or ended before this was recorded.
   */
  contextTokens?: number;
};

/**
 * Who wrote a comment: `operator` through the Gateway (Control UI, CLI),
 * `agent:<id>` through the Workboard tools. Absent on Workboard's own notices
 * and on comments written before sources were recorded.
 */
export type WorkboardCommentSource = "operator" | `agent:${string}`;

export type WorkboardComment = {
  id: string;
  body: string;
  createdAt: number;
  updatedAt?: number;
  source?: WorkboardCommentSource;
};

export type WorkboardLink = {
  id: string;
  type: WorkboardLinkType;
  createdAt: number;
  targetCardId?: string;
  title?: string;
  url?: string;
};

export type WorkboardProof = {
  id: string;
  status: WorkboardProofStatus;
  createdAt: number;
  label?: string;
  command?: string;
  url?: string;
  note?: string;
};

export type WorkboardArtifact = {
  id: string;
  createdAt: number;
  label?: string;
  url?: string;
  path?: string;
  mimeType?: string;
};

export type WorkboardAttachment = {
  id: string;
  cardId: string;
  createdAt: number;
  fileName: string;
  byteSize: number;
  mimeType?: string;
  note?: string;
};

export type WorkboardWorkerLog = {
  id: string;
  createdAt: number;
  level: "info" | "warning" | "error";
  message: string;
  sessionKey?: string;
  runId?: string;
};

export type WorkboardWorkerProtocol = {
  state: "idle" | "running" | "completed" | "blocked" | "violated";
  updatedAt: number;
  detail?: string;
};

export type WorkboardStaleState = {
  detectedAt: number;
  lastSessionUpdatedAt?: number;
  reason: string;
};

export type WorkboardClaim = {
  ownerId: string;
  token: string;
  claimedAt: number;
  lastHeartbeatAt: number;
  expiresAt?: number;
};

export type WorkboardDiagnosticAction = {
  kind: "claim" | "unblock" | "promote" | "reclaim" | "reassign" | "add_proof" | "open_session";
  label: string;
};

export type WorkboardDiagnostic = {
  kind: WorkboardDiagnosticKind;
  severity: WorkboardDiagnosticSeverity;
  title: string;
  detail: string;
  firstSeenAt: number;
  lastSeenAt: number;
  count: number;
  actions: WorkboardDiagnosticAction[];
};

export type WorkboardNotification = {
  id: string;
  kind: WorkboardNotificationKind;
  createdAt: number;
  sequence?: number;
  message: string;
  sessionKey?: string;
  runId?: string;
};

export const WORKBOARD_CHANGED_EVENT = "plugin.workboard.changed";

export type WorkboardChange = {
  epoch: string;
  revision: number;
  cardsRevision?: number;
  sessionsRevision?: number;
};

export type WorkboardWorkspace = {
  kind: "scratch" | "dir" | "worktree";
  path?: string;
  branch?: string;
  sourcePath?: string;
  sourceBranch?: string;
};

export type WorkboardWorkspaceAccess =
  | { unrestricted: true }
  | { unrestricted: false; roots: string[]; writable: boolean };

/**
 * Bringing a finished node ticket's branch back to the host. `pending` is set
 * by the done report and resumed until the import moves the card to review.
 * `questions` is set by a needs_input report: the card waits in review, and a
 * comment newer than `askedAt` plus a move to todo resumes the same session
 * with the answer. `reviewFrom` and `slotWaitNotedAt` mark Workboard's own
 * notices since, as on a published ticket. `escalatedAt` records that an
 * agent passed this round's questions to the operator; a new round starts
 * without it. `grilling` is set by a grill report: the card waits in review
 * while the operator grills in the grill session (`WorkboardNodeGrill`), until
 * that session hands the result back with `workboard_grill_done` or
 * `workboard.cards.grill.end` ends it.
 */
export type WorkboardNodeHandoff =
  | { phase: "pending"; reportedAt: number }
  | { phase: "grilling"; askedAt: number; slotWaitNotedAt?: number }
  | {
      phase: "questions";
      askedAt: number;
      reviewFrom?: number;
      slotWaitNotedAt?: number;
      escalatedAt?: number;
    }
  | {
      phase: "imported";
      headCommit: string;
      importedAt: number;
      /** The board had a verifier at import, so the round waits for its verification before it can be decided. */
      verify?: true;
      /**
       * The agent whose move to done accepted the round at rung b; absent when
       * an operator did. `sampled` is set when that agent's verdict was
       * accept: whether the PR is in the human review sample.
       */
      decidedBy?: `agent:${string}`;
      sampled?: boolean;
    }
  | {
      phase: "published";
      headCommit: string;
      importedAt: number;
      publishedAt: number;
      pullRequestUrl: string;
      /**
       * Card comments up to this time are not review feedback for the next
       * rework round (D56): Workboard's own notices since the publish.
       */
      reviewFrom?: number;
      /** When Workboard noted that the reopened ticket waits for a node-ticket slot. */
      slotWaitNotedAt?: number;
      /**
       * The PR's state on GitHub: set by the publish, then by the PR state
       * sync, which stops reading a merged or closed PR. `checkedAt` is the
       * GitHub read that recorded `state`; a read that finds the same state
       * writes nothing, so an open PR does not churn the card. Merged is a
       * GitHub fact, not the card's accept verdict.
       */
      pullRequest?: { state: WorkboardPullRequestState; checkedAt: number };
      /**
       * When the PR state sync found the PR in conflict with its base and
       * reopened the ticket for a rework round that merges the base: once per
       * publish, so a rework that cannot resolve it does not loop.
       */
      conflictReworkAt?: number;
    };

/** A node ticket PR's state on GitHub; `draft` is an open draft. */
export type WorkboardPullRequestState = "open" | "draft" | "merged" | "closed";

/**
 * Review rework on a published ticket (D54): the worktree restarts at the
 * draft PR branch tip. `round` counts rework rounds so far; `outsideCommits`
 * counts commits others pushed to the branch between rounds. `acceptedAt` is
 * the first publish, which stays the ticket's acceptance through rework.
 * `startCommit` is the branch tip the round started from, so the import check
 * covers only the round's own commits.
 */
export type WorkboardNodeRework = {
  round: number;
  pullRequestUrl: string;
  acceptedAt: number;
  outsideCommits: number;
  startCommit?: string;
  /**
   * Rework rounds whose import added no commit besides merges (a base-branch
   * merge to clear a conflict, or nothing). Ascending, unique. Trust KPIs do
   * not count them as rework.
   */
  unchangedRounds?: number[];
};

/**
 * Question rounds a node ticket asked and got answered. `operatorAnswers`
 * counts rounds an operator answered; those are human touches (D53), rounds
 * only agents answered are not.
 */
export type WorkboardNodeQuestions = {
  rounds: number;
  operatorAnswers: number;
};

/**
 * What the round this worktree record started answers: the questions
 * (`answer`) or the review (`rework`), with card comments after `from` as the
 * input. Preparing the launch drops the handoff that held the cutoff, so a
 * retried launch reads it from here.
 */
export type WorkboardNodeFeedback = {
  kind: "answer" | "rework" | "grill";
  from: number;
};

/**
 * A node ticket's grilling: the ticket session hands it off to a normal
 * session of the card's agent on the Gateway, which interviews the operator
 * until both share an understanding of what to build, then hands the result
 * back. `rounds` counts the grill reports. `attachmentId` is the card's
 * `grilling.md` log of each handoff and result. `sessionKey` is the grill
 * session, set once Workboard created it; only that session may hand the
 * result back. `pending` marks the `end` of the grilling for the next round's
 * brief (its result is the log's result entry at `at`). The round's report
 * clears it, so a retried launch still carries it. A done, blocked, or
 * needs_input report closes an open grill.
 */
export type WorkboardNodeGrill = {
  status: "open" | "closed";
  rounds: number;
  attachmentId: string;
  sessionKey?: string;
  pending?: { kind: "end"; at: number };
};

/**
 * An agent's verdict on one published review round: the `Verdict:
 * accept|rework` comment it left before the round moved to done, or `missed`
 * when none came first. Advisory (shadow acceptance) when the operator moved
 * it; `decidedBy: "agent"` when the agent itself accepted it at rung b, with
 * `sampled` set for an accept verdict. `round`
 * is the rework round the publish closed (0 for the first publish); the
 * operator reworked it when the ticket later reached rework round `round + 1`.
 * `importedAt` and `publishedAt` bound the round's wait for the operator;
 * entries recorded before they existed lack them. `readAt` is when the
 * operator marked a sampled round's PR as read.
 */
export type WorkboardNodeReviewVerdict = {
  round: number;
  verdict: "accept" | "rework" | "missed";
  importedAt?: number;
  publishedAt?: number;
  decidedBy?: "agent";
  sampled?: boolean;
  readAt?: number;
  /** When the board automation's first verdict comment on the round arrived. */
  verdictAt?: number;
  /** The round's verification result, when the board ran one before the publish. */
  verification?: {
    verdict: WorkboardVerificationVerdict;
    model?: string;
    startedAt?: number;
    endedAt?: number;
    /**
     * The round's visual check, copied in only when the operator recorded one
     * before the publish: the verifier's visual verdict beside the operator's.
     * A round decided without a visual check keeps the verifier's read out of
     * the agreement data.
     */
    visual?: { verifier: WorkboardNodeVisualRead["verdict"]; operator: WorkboardVisualVerdict };
  };
  /**
   * The round ran at rung b (`WorkboardNodeWorktree.rung`), so its
   * verification was visible to whoever decided it. Absent = rung a.
   */
  rung?: "b";
};

/**
 * One row of a node ticket session's decision trail: a fork chosen, a unit
 * verified, a pivot or revert, a blocker. Cells are single-line session
 * output; `evidence` points at a commit, a `file:line`, or a command.
 */
export type WorkboardNodeDecision = {
  ts?: string;
  phase: string;
  decision: string;
  why?: string;
  evidence?: string;
  result?: string;
};

/** One file an imported range changed, from `git diff --numstat`; binary files have no line counts. */
export type WorkboardNodeChangedFile = { path: string; previousPath?: string } & (
  | { added: number; deleted: number }
  | { binary: true }
);

/**
 * The files of one kind (screenshots or prototypes) a node ticket round added
 * or changed, read from its `to` commit on the host.
 */
export type WorkboardNodeFileRound = {
  round: number;
  commit: string;
  paths: string[];
};

/** The committed files, or why the host clone could not list them. */
export type WorkboardCommittedNodeFiles =
  | { state: "available"; rounds: WorkboardNodeFileRound[] }
  | { state: "unavailable"; reason: string };

/** A file the running agent wrote under one of the dirs listed for its kind, newest first. */
export type WorkboardLiveNodeFile = { path: string; bytes: number; mtimeMs: number };

/**
 * The files in the card's node worktree right now. `none`: the card has no
 * worktree on its node (not started yet, or its round was imported and the
 * worktree removed).
 */
export type WorkboardLiveNodeFiles =
  | { state: "available"; files: WorkboardLiveNodeFile[] }
  | { state: "unavailable"; reason: string }
  | { state: "none" };

/**
 * Committed files of a card the listed card references with a `relates_to`
 * link. Read one with that card's own id and the round and path listed here.
 */
export type WorkboardLinkedNodeFiles = {
  cardId: string;
  title: string;
  committed: WorkboardCommittedNodeFiles;
};

/**
 * The card's own files: `committed` rounds, and `live` files the running round
 * added or changed in its node worktree (files inherited from the base branch
 * are not listed). Each source fails on its own, so a node outage still shows
 * the committed rounds. `live` is present only when the list asked for it with
 * `live: true`. `linked` holds the committed files of the cards this one
 * references through `relates_to` links, in link order; it is absent when no
 * linked card has any.
 */
export type WorkboardNodeFileListResult = {
  committed: WorkboardCommittedNodeFiles;
  live?: WorkboardLiveNodeFiles;
  linked?: WorkboardLinkedNodeFiles[];
};

/** One file: a round's committed file, or a live file in the node worktree. */
export type WorkboardNodeFileSource = { round: number } | { live: true };

export type WorkboardScreenshotResult = { mimeType: string; contentBase64: string };

/** A prototype HTML file, decoded as UTF-8. */
export type WorkboardPrototypeResult = { html: string };

/** What one round's import changed, `from..to`; `files` is capped, `totals` counts every file. */
export type WorkboardNodeChanges = {
  from: string;
  to: string;
  files: WorkboardNodeChangedFile[];
  totals: { files: number; added: number; deleted: number };
};

/**
 * One finding of a rung b round's standards reviewer. `line` is 1-based in the
 * round's final commit when `fixed` is false, and in the tree the reviewer saw
 * when true. `rule` names the CODING_STANDARDS.md rule.
 */
export type WorkboardNodeFinding = {
  path: string;
  line: number;
  body: string;
  rule?: string;
  fixed: boolean;
};

/**
 * A rung b round's standards review. The counts cover every finding; `items`
 * is capped and absent when the report gave only counts.
 */
export type WorkboardNodeReview = {
  findings: number;
  fixed: number;
  note?: string;
  items?: WorkboardNodeFinding[];
};

/**
 * What one round of a node ticket decided and changed. `round` is the rework
 * round (0 for the first run); its reports append `decisions` and record
 * `review`, its import records `changes`.
 */
export type WorkboardNodeRound = {
  round: number;
  decisions?: WorkboardNodeDecision[];
  changes?: WorkboardNodeChanges;
  review?: WorkboardNodeReview;
};

/** A ticket worktree the dispatcher created on a paired node. */
export type WorkboardNodeWorktree = {
  path: string;
  branch: string;
  baseCommit: string;
  handoff?: WorkboardNodeHandoff;
  rework?: WorkboardNodeRework;
  questions?: WorkboardNodeQuestions;
  feedback?: WorkboardNodeFeedback;
  grill?: WorkboardNodeGrill;
  /** One entry per publish, oldest first; kept across rework rounds. */
  reviews?: WorkboardNodeReviewVerdict[];
  /** Recent rounds, oldest first; kept across rework rounds. */
  rounds?: WorkboardNodeRound[];
  verification?: WorkboardNodeVerification;
  /**
   * The round runs at rung b: its class was at b on the board when it
   * launched, so its brief asked for the standards review. Absent = rung a.
   */
  rung?: "b";
  /**
   * When an operator asked to stop the running session. Set before the abort,
   * so the run's end records a stop (card back in todo, worktree kept), not a
   * failure.
   */
  stopRequestedAt?: number;
};

/**
 * Runs the card as a fresh Claude Code session on a paired node instead of a
 * Gateway subagent. The node keeps its own clone; the dispatcher creates one
 * worktree per card under `worktreesRoot` and records it as `worktree`. The
 * finished branch is bundled back into the host clone at `hostRepoPath`.
 */
export type WorkboardExecutionTarget = {
  kind: "node-claude";
  nodeId: string;
  repoPath: string;
  worktreesRoot: string;
  hostRepoPath: string;
  baseRef?: string;
  model?: string;
  /**
   * Worktree-relative dirs the agent writes screenshots into, listed live
   * while it runs. Absent means `docs/screenshots`.
   */
  screenshotDirs?: string[];
  worktree?: WorkboardNodeWorktree;
};

type WorkboardLaunchIdentity = {
  requestedSessionKey: string;
  provisionalRunId: string;
  preparedAt: number;
};

export type WorkboardLaunchState =
  | (WorkboardLaunchIdentity & { phase: "prepared" })
  | (WorkboardLaunchIdentity & {
      phase: "accepted";
      acceptedAt: number;
      acceptedSessionKey: string;
      acceptedRunId?: string;
    })
  | (WorkboardLaunchIdentity & {
      phase: "failed";
      failedAt: number;
      reason: string;
    });

/**
 * The operator's Start of a node ticket whose parents were not done or whose
 * slot was full. Only that start and a reviewed rework or answer reopen record
 * it, and the card loses it once it leaves todo or ready, is claimed, or is
 * archived; queued tickets start oldest first as parents finish and slots free.
 */
export type WorkboardStartRequest = {
  requestedAt: number;
};

export type WorkboardAutomation = {
  tenant?: string;
  boardId?: string;
  createdByCardId?: string;
  idempotencyKey?: string;
  skills?: string[];
  workspace?: WorkboardWorkspace;
  workspaceAccess?: WorkboardWorkspaceAccess;
  target?: WorkboardExecutionTarget;
  maxRuntimeSeconds?: number;
  maxRetries?: number;
  scheduledAt?: number;
  startRequest?: WorkboardStartRequest;
  probe?: WorkboardProbe;
  summary?: string;
  createdCardIds?: string[];
  dispatchCount?: number;
  lastDispatchAt?: number;
  launch?: WorkboardLaunchState;
};

export type WorkboardBoardMetadata = {
  id: string;
  kind?: "cards" | "sessions";
  sessions?: WorkboardSessionsBoardSpec;
  name?: string;
  description?: string;
  icon?: string;
  color?: string;
  automationJobId?: string;
  defaultWorkspace?: WorkboardWorkspace;
  orchestration?: WorkboardOrchestrationSettings;
  createdAt: number;
  updatedAt: number;
  archivedAt?: number;
};

export type WorkboardBoardSummary = Omit<WorkboardBoardMetadata, "createdAt" | "updatedAt"> & {
  total: number;
  active: number;
  archived: number;
  byStatus: Partial<Record<WorkboardStatus, number>>;
  updatedAt?: number;
};

export type WorkboardOrchestrationSettings = {
  autoDecompose?: boolean;
  autoDecomposePerDispatch?: number;
  defaultAssignee?: string;
  orchestratorProfile?: string;
  /**
   * Project boards name their node target once: new cards on the board copy
   * it unless they bring their own target, a non-scratch workspace, or a
   * linked session. Operator-set only; agent board tools cannot write it.
   */
  defaultTarget?: Omit<WorkboardExecutionTarget, "worktree">;
  /**
   * Label routes ahead of `defaultTarget`: a new card takes the target of the
   * first route sharing one of its labels, under the same skip rules. Each
   * label belongs to at most one route. Operator-set only.
   */
  targetRoutes?: WorkboardTargetRoute[];
  /**
   * Trust-ladder rung per task class (`class:<name>` label, keyed without the
   * prefix). A class not listed is at rung a. Operator-set only.
   */
  classRungs?: Record<string, WorkboardClassRung>;
  /**
   * The independent verification run on each imported round: a session of
   * `agentId` on `model` (`provider/model`) that re-runs the ticket's proof on
   * its node and tries to break the change. Absent = no verification.
   * Operator-set only.
   */
  verifier?: WorkboardVerifierSettings;
};

/**
 * Rung b runs a standards reviewer in the ticket session and lets an agent
 * accept the ticket. `sampleEvery` (default 3) is the share of agent-accepted
 * PRs a human reads: 1 in `sampleEvery`, chosen by the card.
 */
export type WorkboardClassRung = {
  rung: "a" | "b";
  sampleEvery?: number;
  /**
   * Epoch ms when the class last changed rung. The store stamps it when a
   * save changes the rung and carries it otherwise; an explicit value
   * backfills it.
   */
  since?: number;
};

export type WorkboardTargetRoute = {
  labels: string[];
  target: Omit<WorkboardExecutionTarget, "worktree">;
  /**
   * More nodes for the route, tried in order after `target`. A routed card
   * starts on the first of these nodes with a free slot and stays on it once
   * it has a worktree. Needs `maxConcurrent`.
   */
  alternateTargets?: Omit<WorkboardExecutionTarget, "worktree">[];
  /**
   * How many of the route's node tickets may run at once on each of its
   * nodes, within the plugin's node-ticket pool. A ticket counts toward it
   * while its labels match the route and it runs on that node.
   */
  maxConcurrent?: number;
};

export type WorkboardNotificationSubscription = {
  id: string;
  boardId: string;
  cardId?: string;
  sessionKey?: string;
  runId?: string;
  target?: string;
  eventKinds?: WorkboardNotificationKind[];
  lastEventAt?: number;
  lastEventId?: string;
  lastEventSequence?: number;
  deliveredEventIds?: string[];
  createdAt: number;
  updatedAt: number;
};

export type WorkboardMetadata = {
  attempts?: WorkboardRunAttempt[];
  comments?: WorkboardComment[];
  links?: WorkboardLink[];
  proof?: WorkboardProof[];
  artifacts?: WorkboardArtifact[];
  attachments?: WorkboardAttachment[];
  workerLogs?: WorkboardWorkerLog[];
  workerProtocol?: WorkboardWorkerProtocol;
  automation?: WorkboardAutomation;
  claim?: WorkboardClaim;
  diagnostics?: WorkboardDiagnostic[];
  notifications?: WorkboardNotification[];
  templateId?: WorkboardTemplateId;
  archivedAt?: number;
  stale?: WorkboardStaleState;
  lifecycleStatusSourceUpdatedAt?: number;
  failureCount?: number;
};

export type WorkboardCard = {
  id: string;
  title: string;
  notes?: string;
  status: WorkboardStatus;
  priority: WorkboardPriority;
  labels: string[];
  agentId?: string;
  sessionKey?: string;
  runId?: string;
  sourceUrl?: string;
  execution?: WorkboardExecution;
  position: number;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  events?: WorkboardEvent[];
  metadata?: WorkboardMetadata;
};

/**
 * Where a card stands, for an operator who does not follow each step.
 * Derived from recorded facts on operator reads and never stored. `since` is
 * when the card entered the stage; stages read from card events lack it once
 * the event aged out. An imported round is `verifying` or `reviewing` while
 * its verification or the board automation's verdict is outstanding, and
 * `awaiting_review` once the operator can decide it. `review_incomplete` is a
 * round that never got them within the deadline; the operator may decide it.
 */
export type WorkboardCardStage =
  | { kind: "queued"; since: number }
  | { kind: "running"; since?: number; nodeId?: string; reworkRound?: number; attempt?: number }
  | { kind: "questions"; since: number; escalatedAt?: number }
  | { kind: "grilling"; since: number; round: number }
  | { kind: "verifying"; since: number }
  | { kind: "reviewing"; since: number }
  | { kind: "review_incomplete"; since: number; missing: Array<"verification" | "verdict"> }
  | { kind: "awaiting_review"; since: number }
  | {
      kind: "published";
      since: number;
      pullRequestUrl: string;
      reworkRound: number;
      /** Absent until the publish or the PR state sync recorded it. */
      pullRequestState?: WorkboardPullRequestState;
    }
  | { kind: "blocked"; since?: number }
  | { kind: "review"; since?: number }
  | { kind: "done"; since?: number };

/**
 * A card as Gateway operator reads return it; `stage` is absent for idle
 * statuses. `rounds` copies a node ticket's round facts out of its worktree
 * record, which the Control UI never reads.
 */
/**
 * When a node ticket round's verification ran and the board automation's
 * verdict arrived, oldest round first. Derived on operator reads and never
 * stored; it carries times only, so blind review hides nothing it shows.
 * Rounds published before the times were recorded lack the verification.
 */
export type WorkboardRoundReviewTimes = {
  round: number;
  importedAt: number;
  verification?: { startedAt: number; endedAt?: number };
  verdictAt?: number;
};

export type WorkboardOperatorCard = WorkboardCard & {
  stage?: WorkboardCardStage;
  rounds?: WorkboardNodeRound[];
  reviewTimes?: WorkboardRoundReviewTimes[];
  /** A node ticket's draft PR, from its publish on; kept while rework rounds run. */
  pullRequestUrl?: string;
  /** The newest round pushed to `pullRequestUrl`'s branch; it and earlier rounds are on GitHub. */
  publishedRound?: number;
  /** A node ticket's grilling, from its first handoff on; the interview stays in its grill session. */
  grill?: Pick<WorkboardNodeGrill, "status" | "rounds" | "attachmentId" | "sessionKey">;
  /**
   * The imported round's visual check once its verification finished, at
   * every rung: `check` is the operator's, absent while the round waits for
   * one. The verifier's own read stays out of operator reads until then.
   */
  visualCheck?: { round: number; check?: WorkboardNodeVisualCheck };
};

/** One file's diff in one node ticket round, read from the host clone. */
export type WorkboardChangeDiffResult = { diff: string; truncated: boolean };

export type WorkboardListResult = {
  cards: WorkboardCard[];
  statuses: readonly WorkboardStatus[];
};
export {
  createDefaultWorkboardSessionsBoardSpec,
  normalizeWorkboardSessionsBoardSpec,
  patchWorkboardSessionsBoardSpec,
} from "./sessions-board.js";
export type {
  WorkboardSessionFacts,
  WorkboardSessionPlacement,
  WorkboardSessionsBoard,
  WorkboardSessionsBoardRead,
  WorkboardSessionsBoardRevision,
  WorkboardSessionsBoardSpec,
  WorkboardSessionsBoardView,
  WorkboardSessionsColumn,
  WorkboardSessionsColumnMatch,
  WorkboardSessionsObserverHealth,
} from "./sessions-board.js";
export type * from "./probes.js";

export type * from "./trust.js";

/** One card as a Factory overview row: what it is and where it stands. */
export type WorkboardOverviewCard = {
  cardId: string;
  boardId: string;
  title: string;
  /** The operator summary (`metadata.automation.summary`), when the card has one. */
  summary?: string;
  stage?: WorkboardCardStage;
};

/**
 * Why a card waits on the operator: a review only the operator may decide, a
 * PR an agent accepted into the human review sample, questions passed to the
 * operator (or with no automation job to answer them), a grilling question
 * only the operator answers, or a block.
 */
export type WorkboardOverviewWaitReason =
  | "decide"
  | "sampled"
  | "questions"
  | "grilling"
  | "blocked";

export type WorkboardOverviewWaiting = WorkboardOverviewCard & {
  reason: WorkboardOverviewWaitReason;
  /** Absent when the card entered the wait before its newest 50 events. */
  waitingSince?: number;
};

/** A card waiting on the factory: queued, running, or with an agent to review, answer, or reopen it. */
export type WorkboardOverviewInFlight = WorkboardOverviewCard & {
  /** Node tickets only: the paired node, the rework round, and the last run's turn-end context. */
  nodeId?: string;
  round?: number;
  contextTokens?: number;
};

export type WorkboardOverviewShipped = WorkboardOverviewCard & {
  shippedAt: number;
  pullRequestUrl?: string;
  /** Node tickets only: review rounds published, and who accepted the latest. */
  rounds?: number;
  decidedBy?: "agent" | "operator";
  /** Whether an agent-accepted PR is in the human review sample. */
  sampled?: boolean;
  /**
   * The agent's shadow verdict on an operator-decided round. Whether the
   * operator agreed shows only once a later rework round does or does not
   * follow, so the trust KPIs score it, not this row.
   */
  shadowVerdict?: "accept" | "rework";
};

export type WorkboardOverviewInsight = WorkboardOverviewCard & {
  label: "gardener" | "architecture";
  createdAt: number;
};

/**
 * The Factory overview: a read-time projection of the operator's cards, never
 * stored. Rows and `open` leave out archived cards and cards on archived
 * boards; `week` counts as `workboard.cards.trust` does. A pending agent
 * verdict never shows.
 */
export type WorkboardOverviewResult = {
  /** The board read, or `all`. */
  boardId: string;
  generatedAt: number;
  /** Oldest wait first. */
  needsYou: WorkboardOverviewWaiting[];
  /** Longest in its stage first. */
  inFlight: WorkboardOverviewInFlight[];
  /** Shipped in the last 7 days, newest first. */
  shipped: WorkboardOverviewShipped[];
  /** Open backlog cards labeled `gardener` or `architecture`, newest first. */
  insights: WorkboardOverviewInsight[];
  /** Unarchived cards per status, `done` excluded. */
  open: Partial<Record<WorkboardStatus, number>>;
  /** The current week of the trust KPIs (`workboard.cards.trust`). */
  week: WorkboardTrustWeek;
};

/** `workboard.transcriptViewer`: the transcript viewer's loopback port on the Gateway host, or null when unset. */
export type WorkboardTranscriptViewerResult = { port: number | null };

/** `workboard.officeViewer`: the office viewer's loopback port on the Gateway host, or null when unset. */
export type WorkboardOfficeViewerResult = { port: number | null };

/** `workboard.architectureViewer`: the architecture viewer's loopback port on the Gateway host, or null when unset. */
export type WorkboardArchitectureViewerResult = { port: number | null };
