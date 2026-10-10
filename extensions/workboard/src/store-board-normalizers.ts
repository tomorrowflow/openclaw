import {
  createDefaultWorkboardSessionsBoardSpec,
  type WorkboardBoardMetadata,
  type WorkboardOrchestrationSettings,
  type WorkboardTargetRoute,
} from "@openclaw/workboard-contract";
import { resolveOptionalIntegerOption } from "openclaw/plugin-sdk/number-runtime";
import { isRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { WorkboardBoardInput } from "./store-inputs.js";
import { normalizeBoardId, normalizeLabels, normalizeWorkspace } from "./store-normalizers.js";
import { normalizeExecutionTarget } from "./store-target-normalizers.js";
import { normalizeBoundedString } from "./store-value-normalizers.js";

export function normalizeBoardMetadata(
  input: WorkboardBoardInput,
  fallback: WorkboardBoardMetadata | undefined,
  now = Date.now(),
): WorkboardBoardMetadata {
  const id = normalizeBoardId(input.id, fallback?.id) ?? "default";
  if (input.kind !== undefined && input.kind !== "cards" && input.kind !== "sessions") {
    throw new Error("board kind must be cards or sessions.");
  }
  if (fallback && input.kind !== undefined && input.kind !== (fallback.kind ?? "cards")) {
    throw new Error("board kind cannot be changed after creation.");
  }
  const kind = input.kind === "sessions" ? "sessions" : fallback?.kind;
  if (kind === "sessions" && id === "default") {
    throw new Error("board kind cannot be changed after creation: default is a cards board.");
  }
  const name = normalizeBoundedString(input.name, fallback?.name, 120, "board name");
  const description = normalizeBoundedString(
    input.description,
    fallback?.description,
    1000,
    "board description",
  );
  const clearAppearance = input.clearAppearance === undefined ? [] : input.clearAppearance;
  if (
    !Array.isArray(clearAppearance) ||
    clearAppearance.some((field) => field !== "icon" && field !== "color")
  ) {
    throw new Error("clearAppearance must be an array containing only icon or color.");
  }
  // Legacy empty/null inputs preserve appearance. Explicit clears take precedence.
  const icon = clearAppearance.includes("icon")
    ? undefined
    : normalizeBoundedString(input.icon, fallback?.icon, 40, "board icon");
  const color = clearAppearance.includes("color")
    ? undefined
    : normalizeBoundedString(input.color, fallback?.color, 40, "board color");
  let automationJobId = fallback?.automationJobId;
  if (Object.hasOwn(input, "automationJobId")) {
    automationJobId = normalizeOptionalString(input.automationJobId);
    if (!automationJobId) {
      throw new Error("automation job id must be a non-empty string.");
    }
    if (automationJobId.length > 128) {
      throw new Error("automation job id must be 128 characters or fewer.");
    }
  }
  const defaultWorkspace = Object.hasOwn(input, "defaultWorkspace")
    ? normalizeWorkspace(input.defaultWorkspace, fallback?.defaultWorkspace)
    : fallback?.defaultWorkspace;
  const orchestration = Object.hasOwn(input, "orchestration")
    ? normalizeOrchestration(input.orchestration, fallback?.orchestration)
    : fallback?.orchestration;
  const archivedAt = Object.hasOwn(input, "archived")
    ? input.archived === false
      ? undefined
      : now
    : fallback?.archivedAt;
  return {
    id,
    ...(kind ? { kind } : {}),
    ...(kind === "sessions"
      ? { sessions: fallback?.sessions ?? createDefaultWorkboardSessionsBoardSpec() }
      : {}),
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
    ...(icon ? { icon } : {}),
    ...(color ? { color } : {}),
    ...(automationJobId ? { automationJobId } : {}),
    ...(defaultWorkspace ? { defaultWorkspace } : {}),
    ...(orchestration ? { orchestration } : {}),
    createdAt: fallback?.createdAt ?? now,
    updatedAt: now,
    ...(archivedAt ? { archivedAt } : {}),
  };
}

function normalizeOrchestration(
  value: unknown,
  fallback?: WorkboardOrchestrationSettings,
): WorkboardOrchestrationSettings | undefined {
  if (!isRecord(value)) {
    return fallback;
  }
  const record = value;
  const autoDecompose =
    typeof record.autoDecompose === "boolean" ? record.autoDecompose : fallback?.autoDecompose;
  const autoDecomposePerDispatch =
    resolveOptionalIntegerOption(record.autoDecomposePerDispatch, { min: 1, max: 20 }) ??
    fallback?.autoDecomposePerDispatch;
  const defaultAssignee = normalizeBoundedString(
    record.defaultAssignee,
    fallback?.defaultAssignee,
    120,
    "default assignee",
  );
  const orchestratorProfile = normalizeBoundedString(
    record.orchestratorProfile,
    fallback?.orchestratorProfile,
    120,
    "orchestrator profile",
  );
  // Without a fallback the normalizer drops dispatcher-owned worktree state.
  const defaultTarget = Object.hasOwn(record, "defaultTarget")
    ? normalizeExecutionTarget(record.defaultTarget)
    : fallback?.defaultTarget;
  const targetRoutes = Object.hasOwn(record, "targetRoutes")
    ? normalizeTargetRoutes(record.targetRoutes)
    : fallback?.targetRoutes;
  const next: WorkboardOrchestrationSettings = {
    ...(autoDecompose !== undefined ? { autoDecompose } : {}),
    ...(autoDecomposePerDispatch ? { autoDecomposePerDispatch } : {}),
    ...(defaultAssignee ? { defaultAssignee } : {}),
    ...(orchestratorProfile ? { orchestratorProfile } : {}),
    ...(defaultTarget ? { defaultTarget } : {}),
    ...(targetRoutes?.length ? { targetRoutes } : {}),
  };
  return Object.keys(next).length ? next : undefined;
}

const MAX_TARGET_ROUTES = 20;

/** Labels match card labels exactly, so they share the card label normalizer. */
function normalizeTargetRoutes(value: unknown): WorkboardTargetRoute[] {
  if (value === null) {
    return [];
  }
  if (!Array.isArray(value) || value.length > MAX_TARGET_ROUTES) {
    throw new Error(`target routes must be an array of at most ${MAX_TARGET_ROUTES} routes.`);
  }
  const claimed = new Set<string>();
  return value.map((route) => {
    if (!isRecord(route) || !Array.isArray(route.labels)) {
      throw new Error("each target route needs labels and a target.");
    }
    // The card label normalizer stops at 12; refuse rather than drop a route label.
    if (route.labels.length > 12) {
      throw new Error("a target route can name at most 12 labels.");
    }
    const labels = normalizeLabels(route.labels);
    if (!labels.length) {
      throw new Error("target route labels must name at least one label.");
    }
    for (const label of labels) {
      if (claimed.has(label)) {
        throw new Error(`target route label ${label} appears in more than one route.`);
      }
      claimed.add(label);
    }
    const target = normalizeExecutionTarget(route.target);
    if (!target) {
      throw new Error("each target route needs labels and a target.");
    }
    return { labels, target };
  });
}
