import {
  createDefaultWorkboardSessionsBoardSpec,
  type WorkboardBoardMetadata,
  type WorkboardClassRung,
  type WorkboardOrchestrationSettings,
  type WorkboardTargetRoute,
} from "@openclaw/workboard-contract";
import { resolveOptionalIntegerOption } from "openclaw/plugin-sdk/number-runtime";
import { isRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { WorkboardBoardInput } from "./store-inputs.js";
import { normalizeBoardId, normalizeWorkspace } from "./store-normalizers.js";
import { normalizeCappedStringList } from "./store-string-lists.js";
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
    ? normalizeOrchestration(input.orchestration, fallback?.orchestration, now)
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
  fallback: WorkboardOrchestrationSettings | undefined,
  now: number,
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
  const classRungs = Object.hasOwn(record, "classRungs")
    ? normalizeClassRungs(record.classRungs, fallback?.classRungs, now)
    : fallback?.classRungs;
  const next: WorkboardOrchestrationSettings = {
    ...(autoDecompose !== undefined ? { autoDecompose } : {}),
    ...(autoDecomposePerDispatch ? { autoDecomposePerDispatch } : {}),
    ...(defaultAssignee ? { defaultAssignee } : {}),
    ...(orchestratorProfile ? { orchestratorProfile } : {}),
    ...(defaultTarget ? { defaultTarget } : {}),
    ...(targetRoutes?.length ? { targetRoutes } : {}),
    ...(classRungs && Object.keys(classRungs).length ? { classRungs } : {}),
  };
  return Object.keys(next).length ? next : undefined;
}

const MAX_CLASS_RUNGS = 50;
// A card label is at most 40 characters, so a class name after `class:` is at most 34.
const MAX_CLASS_NAME_CHARS = 34;

function normalizeClassRungs(
  value: unknown,
  stored: Record<string, WorkboardClassRung> | undefined,
  now: number,
): Record<string, WorkboardClassRung> {
  if (value === null) {
    return {};
  }
  const entries = isRecord(value) ? Object.entries(value) : undefined;
  if (!entries || entries.length > MAX_CLASS_RUNGS) {
    throw new Error(`class rungs must be an object of at most ${MAX_CLASS_RUNGS} classes.`);
  }
  return Object.fromEntries(
    entries.map(([name, entry]): [string, WorkboardClassRung] => {
      if (!name || name !== name.trim() || name.length > MAX_CLASS_NAME_CHARS) {
        throw new Error(
          `class rung names must be 1 to ${MAX_CLASS_NAME_CHARS} characters without surrounding spaces.`,
        );
      }
      if (name.startsWith("class:")) {
        throw new Error(`class rung ${name} must name the class without the class: prefix.`);
      }
      if (!isRecord(entry) || (entry.rung !== "a" && entry.rung !== "b")) {
        throw new Error(`class rung ${name} needs rung a or b.`);
      }
      let sampleEvery: number | undefined;
      if (entry.sampleEvery !== undefined && entry.sampleEvery !== null) {
        sampleEvery = resolveOptionalIntegerOption(entry.sampleEvery, { min: 1, max: 100 });
        if (sampleEvery === undefined || sampleEvery !== entry.sampleEvery) {
          throw new Error(`class rung ${name} sampleEvery must be an integer from 1 to 100.`);
        }
      }
      const previous = stored && Object.hasOwn(stored, name) ? stored[name] : undefined;
      let since: number | undefined;
      if (entry.since !== undefined && entry.since !== null) {
        // An explicit value is the operator's backfill of a change made before stamping.
        since = resolveOptionalIntegerOption(entry.since, { min: 0, max: now });
        if (since === undefined || since !== entry.since) {
          throw new Error(`class rung ${name} since must be an epoch ms integer from 0 to now.`);
        }
      } else {
        // An unlisted class is at rung a, so listing it at a changes nothing.
        since = entry.rung === (previous?.rung ?? "a") ? previous?.since : now;
      }
      return [
        name,
        {
          rung: entry.rung,
          ...(sampleEvery === undefined ? {} : { sampleEvery }),
          ...(since === undefined ? {} : { since }),
        },
      ];
    }),
  );
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
    const labels = normalizeCappedStringList(route.labels, "labels");
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
    const alternateTargets = normalizeAlternateTargets(route.alternateTargets, target.nodeId);
    if (route.maxConcurrent === undefined || route.maxConcurrent === null) {
      // Without a per-node cap every card would take the first node.
      if (alternateTargets.length) {
        throw new Error("a target route with alternateTargets needs maxConcurrent.");
      }
      return { labels, target };
    }
    const maxConcurrent = resolveOptionalIntegerOption(route.maxConcurrent, { min: 1, max: 16 });
    if (maxConcurrent === undefined || maxConcurrent !== route.maxConcurrent) {
      throw new Error("target route maxConcurrent must be an integer from 1 to 16.");
    }
    return {
      labels,
      target,
      ...(alternateTargets.length ? { alternateTargets } : {}),
      maxConcurrent,
    };
  });
}

const MAX_ALTERNATE_TARGETS = 7;

function normalizeAlternateTargets(
  value: unknown,
  primaryNodeId: string,
): NonNullable<WorkboardTargetRoute["alternateTargets"]> {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value) || value.length > MAX_ALTERNATE_TARGETS) {
    throw new Error(
      `target route alternateTargets must be an array of at most ${MAX_ALTERNATE_TARGETS} targets.`,
    );
  }
  const nodeIds = new Set([primaryNodeId]);
  return value.map((entry) => {
    const target = normalizeExecutionTarget(entry);
    if (!target) {
      throw new Error("each target route alternate target needs a node-claude target.");
    }
    // Slots are counted per node, so a node can appear in a route only once.
    if (nodeIds.has(target.nodeId)) {
      throw new Error(`target route node ${target.nodeId} appears more than once.`);
    }
    nodeIds.add(target.nodeId);
    return target;
  });
}
