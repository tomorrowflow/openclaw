import type { WorkboardSessionsBoardSpec } from "./sessions-board.js";

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
 * notices since, as on a published ticket.
 */
export type WorkboardNodeHandoff =
  | { phase: "pending"; reportedAt: number }
  | { phase: "questions"; askedAt: number; reviewFrom?: number; slotWaitNotedAt?: number }
  | { phase: "imported"; headCommit: string; importedAt: number }
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
    };

/**
 * Review rework on a published ticket (D54): the worktree restarts at the
 * draft PR branch tip. `round` counts rework rounds so far; `outsideCommits`
 * counts commits others pushed to the branch between rounds. `acceptedAt` is
 * the first publish, which stays the ticket's acceptance through rework.
 */
export type WorkboardNodeRework = {
  round: number;
  pullRequestUrl: string;
  acceptedAt: number;
  outsideCommits: number;
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
  kind: "answer" | "rework";
  from: number;
};

/**
 * An agent's advisory verdict on one published review round (shadow
 * acceptance): the `Verdict: accept|rework` comment it left before the
 * operator moved the round to done, or `missed` when none came first. `round`
 * is the rework round the publish closed (0 for the first publish); the
 * operator reworked it when the ticket later reached rework round `round + 1`.
 */
export type WorkboardNodeReviewVerdict = {
  round: number;
  verdict: "accept" | "rework" | "missed";
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
  /** One entry per publish, oldest first; kept across rework rounds. */
  reviews?: WorkboardNodeReviewVerdict[];
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
};

export type WorkboardTargetRoute = {
  labels: string[];
  target: Omit<WorkboardExecutionTarget, "worktree">;
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

/** Trust KPI counts for one task class or for all node tickets (dev loop D9/D53). */
export type WorkboardTrustCounts = {
  /** Node tickets in scope, archived ones included. */
  tickets: number;
  /** Published as a draft PR, i.e. accepted at least once. */
  accepted: number;
  /** Accepted with no rework round, no outside commit, and no operator-answered question. */
  cleanAccepted: number;
  /** Reached the import without ever being blocked. */
  firstPass: number;
  /** Blocked at least once (each block needed a person or a re-plan). */
  blocked: number;
  reworkRounds: number;
  outsideCommits: number;
  /** Answered needs_input rounds, and how many of them an operator answered. */
  questionRounds: number;
  operatorAnswers: number;
  attempts: number;
  /**
   * Published review rounds with an agent verdict, and how many matched the
   * operator: `accept` with no rework after the publish, or `rework` with one.
   */
  verdictRounds: number;
  verdictAgreedRounds: number;
  /** Tickets whose every round has a verdict, and those where every verdict matched. */
  verdictCards: number;
  verdictAgreedCards: number;
  /** Rounds published before any verdict; excluded from both rates. */
  verdictMissed: number;
};

/** Accepted tickets in one UTC week (Monday 00:00), by acceptance time. */
export type WorkboardTrustWeek = {
  weekStart: number;
  accepted: number;
  /** Accepted with zero human touches: no rework, outside commit, or block. */
  autonomous: number;
  medianLeadTimeMs?: number;
};

/**
 * A read-time projection of node ticket card facts, never stored. Task class
 * comes from a `class:<name>` label. Blocks are counted from card events,
 * which keep the newest 50 per card.
 */
export type WorkboardTrustResult = {
  boardId: string;
  generatedAt: number;
  total: WorkboardTrustCounts;
  classes: Array<WorkboardTrustCounts & { taskClass: string }>;
  /** The last 8 weeks, oldest first, including the current one. */
  weeks: WorkboardTrustWeek[];
};
