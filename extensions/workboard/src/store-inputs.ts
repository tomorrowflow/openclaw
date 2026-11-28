import type {
  WorkboardBoardSummary,
  WorkboardCard,
  WorkboardDiagnostic,
  WorkboardEvent,
  WorkboardExecutionTarget,
  WorkboardLaunchState,
  WorkboardResultEvidence,
  WorkboardStartRequest,
  WorkboardWorkspace,
  WorkboardWorkspaceAccess,
} from "@openclaw/workboard-contract";
import type { WorkboardClaimSlot } from "./store-constants.js";

type WorkboardCardInput = {
  title?: unknown;
  notes?: unknown;
  status?: unknown;
  priority?: unknown;
  labels?: unknown;
  kind?: unknown;
  /** Operator-placed number on a board with a key; see `assignCardNumber`. */
  release?: unknown;
  seq?: unknown;
  agentId?: unknown;
  sessionKey?: unknown;
  runId?: unknown;
  sourceUrl?: unknown;
  execution?: unknown;
  metadata?: unknown;
  templateId?: unknown;
  position?: unknown;
  tenant?: unknown;
  boardId?: unknown;
  createdByCardId?: unknown;
  idempotencyKey?: unknown;
  skills?: unknown;
  touches?: unknown;
  workspace?: unknown;
  /** Trusted mutation provenance; not accepted from public tool schemas. */
  workspaceAccess?: unknown;
  maxRuntimeSeconds?: unknown;
  maxRetries?: unknown;
  scheduledAt?: unknown;
  /** The operator summary, `metadata.automation.summary`. */
  summary?: unknown;
  startedAt?: unknown;
  completedAt?: unknown;
  parents?: unknown;
};

export type WorkboardCardPatch = WorkboardCardInput;
/** Internal builders carry launch state separately from untrusted metadata. */
export type WorkboardOwnedCardPatch = WorkboardCardPatch & {
  ownedLaunch?: WorkboardLaunchState;
  ownedEvidence?: WorkboardResultEvidence[];
  ownedStartRequest?: WorkboardStartRequest;
};
/** Splits a trusted builder's patch into the public patch and the options that carry its owned parts. */
export function splitOwnedCardPatch(owned: WorkboardOwnedCardPatch) {
  const { ownedLaunch, ownedEvidence, ownedStartRequest, ...patch } = owned;
  return {
    patch,
    owned: {
      automationLaunch: ownedLaunch,
      automationEvidence: ownedEvidence,
      startRequest: ownedStartRequest,
    },
  };
}
/** An agent tool mutation's author; mutations without one are the operator's or Workboard's own. */
export type WorkboardAgentActor = `agent:${string}`;

export type WorkboardUpdateCardOptions = {
  actor?: WorkboardAgentActor;
  /** Trusted host writes may record host-owned automation state (node worktree, probe). */
  allowAutomationLaunch?: boolean;
  /** Queues the card's start; built only by Workboard's start paths. */
  startRequest?: WorkboardStartRequest;
  automationLaunch?: WorkboardLaunchState;
  /** Replaces automation.evidence; built only by Workboard's evidence writers. */
  automationEvidence?: WorkboardResultEvidence[];
  allowMetadataDependencyLinks?: boolean;
  enforceStatusHolds?: boolean;
  event?: Omit<WorkboardEvent, "id" | "at">;
  eventAt?: number;
  expectedUpdatedAt?: number;
  claimSlot?: { slot: WorkboardClaimSlot; now: number };
  preserveProofId?: string;
  preserveNotificationId?: string;
};
export type WorkboardCommentInput = { body?: unknown };
export type WorkboardLinkInput = {
  type?: unknown;
  targetCardId?: unknown;
  title?: unknown;
  url?: unknown;
};
export type WorkboardLinkedCreateInput = WorkboardCardInput;
export type WorkboardProofInput = {
  status?: unknown;
  label?: unknown;
  command?: unknown;
  url?: unknown;
  note?: unknown;
};
export type WorkboardArtifactInput = {
  label?: unknown;
  url?: unknown;
  path?: unknown;
  mimeType?: unknown;
};
export type WorkboardAttachmentInput = {
  fileName?: unknown;
  contentBase64?: unknown;
  mimeType?: unknown;
  note?: unknown;
};
export type WorkboardWorkerLogInput = Pick<WorkboardCardInput, "sessionKey" | "runId"> & {
  level?: unknown;
  message?: unknown;
};
export type WorkboardProtocolViolationInput = Pick<WorkboardCardInput, "sessionKey" | "runId"> & {
  detail?: unknown;
};
export type WorkboardClaimInput = WorkboardMutationScope & {
  ttlSeconds?: unknown;
};
export type WorkboardClaimOptions = {
  assertOwnerCurrent?: () => void;
  /** Trusted dispatcher guard; never accepted from public tool or gateway input. */
  expectedAuthority?: {
    boardId: string;
    status: WorkboardCard["status"];
    agentId?: string;
    workspace?: WorkboardWorkspace;
    workspaceAccess?: WorkboardWorkspaceAccess;
    target?: WorkboardExecutionTarget;
  };
  /** Trusted legacy-card adoption; applied only while expectedAuthority still matches. */
  adoptWorkspaceAccess?: WorkboardWorkspaceAccess;
};
export type WorkboardHeartbeatInput = WorkboardMutationScope & {
  note?: unknown;
};
export type WorkboardBulkInput = {
  ids?: unknown;
  patch?: unknown;
  archived?: unknown;
};
export type WorkboardCompleteInput = WorkboardMutationScope & {
  summary?: unknown;
  proof?: unknown;
  proofId?: unknown;
  artifacts?: unknown;
  createdCardIds?: unknown;
  /** Optional worker claims; never required and never checked before completion. */
  claims?: unknown;
};
export type WorkboardVerifyInput = {
  scope?: unknown;
  outcome?: unknown;
  claimId?: unknown;
  proofId?: unknown;
  artifactId?: unknown;
  runId?: unknown;
  note?: unknown;
  url?: unknown;
};
export type WorkboardBlockInput = WorkboardMutationScope & {
  reason?: unknown;
};
export type WorkboardDispatchResult = {
  promoted: WorkboardCard[];
  reclaimed: WorkboardCard[];
  blocked: WorkboardCard[];
  orchestrated: WorkboardCard[];
  count: number;
};
export type WorkboardListOptions = {
  boardId?: unknown;
};
export type WorkboardDispatchOptions = WorkboardListOptions & {
  now?: unknown;
  assertOwnerCurrent?: () => void;
};
export type WorkboardStatsResult = WorkboardBoardSummary & {
  byAgent: Record<string, number>;
  oldestReadyAgeMs?: number;
};
export type WorkboardPromoteInput = {
  force?: unknown;
  reason?: unknown;
};
export type WorkboardReassignInput = {
  agentId?: unknown;
  status?: unknown;
  resetFailures?: unknown;
  reason?: unknown;
};
export type WorkboardReclaimInput = Pick<WorkboardReassignInput, "status" | "reason">;
export type WorkboardBoardInput = {
  id?: unknown;
  kind?: unknown;
  name?: unknown;
  description?: unknown;
  icon?: unknown;
  color?: unknown;
  clearAppearance?: unknown;
  automationJobId?: unknown;
  defaultWorkspace?: unknown;
  orchestration?: unknown;
  archived?: unknown;
};
export type WorkboardSpecifyInput = WorkboardCardPatch & {
  summary?: unknown;
};
export type WorkboardDecomposeInput = {
  summary?: unknown;
  children?: unknown;
  completeParent?: unknown;
};
export type WorkboardNotificationSubscribeInput = WorkboardNotificationListOptions & {
  sessionKey?: unknown;
  runId?: unknown;
  target?: unknown;
  eventKinds?: unknown;
};
export type WorkboardNotificationListOptions = {
  boardId?: unknown;
  cardId?: unknown;
};
export type WorkboardNotificationEventsInput = WorkboardNotificationListOptions & {
  subscriptionId?: unknown;
  limit?: unknown;
};
export type WorkboardMutationScope = {
  ownerId?: unknown;
  token?: unknown;
  /** Host run id of the calling agent turn; refuses writes from a superseded attempt. */
  runId?: unknown;
};

export type WorkboardDiagnosticsResult = {
  diagnostics: Array<{
    card: WorkboardCard;
    diagnostics: WorkboardDiagnostic[];
  }>;
  count: number;
};
