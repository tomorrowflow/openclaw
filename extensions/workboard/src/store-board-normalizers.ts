import {
  createDefaultWorkboardSessionsBoardSpec,
  type WorkboardBoardMetadata,
  type WorkboardClassRung,
  type WorkboardOrchestrationSettings,
  type WorkboardPreviewSecretRef,
  type WorkboardPreviewSettings,
  type WorkboardTargetRoute,
  type WorkboardVerifierSettings,
} from "@openclaw/workboard-contract";
import { resolveOptionalIntegerOption } from "openclaw/plugin-sdk/number-runtime";
import { isSecretRef, isValidSecretRef } from "openclaw/plugin-sdk/secret-input";
import { isRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeHeldPaths } from "./held-paths.js";
import type { WorkboardBoardInput } from "./store-inputs.js";
import { normalizeBoardId, normalizeWorkspace } from "./store-normalizers.js";
import { normalizeCappedStringList } from "./store-string-lists.js";
import { normalizeExecutionTarget, normalizePreviewArgv } from "./store-target-normalizers.js";
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
  const heldPaths = Object.hasOwn(record, "heldPaths")
    ? normalizeHeldPaths(record.heldPaths)
    : fallback?.heldPaths;
  const verifier = Object.hasOwn(record, "verifier")
    ? normalizeVerifier(record.verifier, "verifier")
    : fallback?.verifier;
  const crossVerifier = Object.hasOwn(record, "crossVerifier")
    ? normalizeVerifier(record.crossVerifier, "crossVerifier")
    : fallback?.crossVerifier;
  const preview = Object.hasOwn(record, "preview")
    ? normalizePreviewSettings(record.preview)
    : fallback?.preview;
  // It runs only after the verifier passed, so alone it would never run.
  if (crossVerifier && !verifier) {
    throw new Error("crossVerifier needs a verifier: it runs after the verifier passed.");
  }
  const next: WorkboardOrchestrationSettings = {
    ...(autoDecompose !== undefined ? { autoDecompose } : {}),
    ...(autoDecomposePerDispatch ? { autoDecomposePerDispatch } : {}),
    ...(defaultAssignee ? { defaultAssignee } : {}),
    ...(orchestratorProfile ? { orchestratorProfile } : {}),
    ...(defaultTarget ? { defaultTarget } : {}),
    ...(targetRoutes?.length ? { targetRoutes } : {}),
    ...(classRungs && Object.keys(classRungs).length ? { classRungs } : {}),
    ...(heldPaths?.length ? { heldPaths } : {}),
    ...(verifier ? { verifier } : {}),
    ...(crossVerifier ? { crossVerifier } : {}),
    ...(preview ? { preview } : {}),
  };
  return Object.keys(next).length ? next : undefined;
}

const MIN_PREVIEW_PORT = 1024;
const MAX_PREVIEW_PORT = 65535;
const MAX_PREVIEW_ENV = 32;
const PREVIEW_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

// `preview: null` removes it.
function normalizePreviewSettings(value: unknown): WorkboardPreviewSettings | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (!isRecord(value) || !isRecord(value.ports)) {
    throw new Error("preview needs up, down, and ports: { from, to }.");
  }
  const up = normalizePreviewArgv(value.up, "preview up");
  const down = normalizePreviewArgv(value.down, "preview down");
  const { from, to } = value.ports;
  if (!isPreviewPort(from) || !isPreviewPort(to) || from > to) {
    throw new Error(
      `preview ports must be integers from ${MIN_PREVIEW_PORT} to ${MAX_PREVIEW_PORT} with from <= to.`,
    );
  }
  const env = normalizePreviewEnv(value.env);
  return { up, down, ports: { from, to }, ...(env ? { env } : {}) };
}

// Values are SecretRefs only, so board reads never carry a credential.
function normalizePreviewEnv(
  value: unknown,
): Record<string, WorkboardPreviewSecretRef> | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error("preview env must map variable names to SecretRefs.");
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_PREVIEW_ENV) {
    throw new Error(`preview env takes at most ${MAX_PREVIEW_ENV} variables.`);
  }
  const env: Record<string, WorkboardPreviewSecretRef> = {};
  for (const [name, ref] of entries) {
    if (!PREVIEW_ENV_NAME.test(name)) {
      throw new Error(
        `preview env name ${JSON.stringify(name.slice(0, 64))} must be letters, digits, and underscores, not starting with a digit.`,
      );
    }
    if (!isSecretRef(ref) || !isValidSecretRef(ref)) {
      throw new Error(
        `preview env ${name} must be a SecretRef such as {"source": "store", "provider": "default", "id": "${name.toUpperCase()}"}; store the value with \`openclaw secrets store set ${name.toUpperCase()}\`.`,
      );
    }
    env[name] = ref;
  }
  return entries.length > 0 ? env : undefined;
}

function isPreviewPort(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_PREVIEW_PORT &&
    value <= MAX_PREVIEW_PORT
  );
}

// The same `provider/model` shape a session's `model` takes; `verifier: null` removes it.
const VERIFIER_MODEL_PATTERN = /^[^\s/]+\/\S+$/;

function normalizeVerifier(
  value: unknown,
  field: "verifier" | "crossVerifier",
): WorkboardVerifierSettings | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(`${field} needs a non-empty agentId and a model.`);
  }
  const agentId = normalizeBoundedString(value.agentId, undefined, 120, `${field} agentId`);
  const model = normalizeBoundedString(value.model, undefined, 160, `${field} model`);
  if (!agentId || !model) {
    throw new Error(`${field} needs a non-empty agentId and a model.`);
  }
  if (!VERIFIER_MODEL_PATTERN.test(model)) {
    throw new Error(`${field} model ${model} must be provider/model.`);
  }
  const fallbacks = normalizeVerifierFallbacks(value.fallbacks, model, field);
  const settings = { agentId, model, ...(fallbacks.length ? { fallbacks } : {}) };
  const rawSample = value.sampleEvery;
  if (rawSample === undefined || rawSample === null) {
    return settings;
  }
  if (field === "verifier") {
    throw new Error("verifier verifies every round; sampleEvery belongs to the crossVerifier.");
  }
  const sampleEvery = resolveOptionalIntegerOption(rawSample, { min: 1, max: 100 });
  if (sampleEvery === undefined || sampleEvery !== rawSample) {
    throw new Error(`${field} sampleEvery must be an integer from 1 to 100.`);
  }
  return { ...settings, sampleEvery };
}

const MAX_VERIFIER_FALLBACKS = 5;

function normalizeVerifierFallbacks(
  value: unknown,
  model: string,
  field: "verifier" | "crossVerifier",
): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value) || value.length > MAX_VERIFIER_FALLBACKS) {
    throw new Error(
      `${field} fallbacks must be a list of at most ${MAX_VERIFIER_FALLBACKS} provider/model entries.`,
    );
  }
  const fallbacks = value.map((entry) => {
    const fallback = normalizeBoundedString(entry, undefined, 160, `${field} fallback`);
    if (!fallback || !VERIFIER_MODEL_PATTERN.test(fallback)) {
      throw new Error(`${field} fallback ${String(entry)} must be provider/model.`);
    }
    return fallback;
  });
  if (new Set([model, ...fallbacks]).size !== fallbacks.length + 1) {
    throw new Error(`${field} fallbacks must differ from its model and from each other.`);
  }
  return fallbacks;
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
      if (!isRecord(entry) || (entry.rung !== "a" && entry.rung !== "b" && entry.rung !== "c")) {
        throw new Error(`class rung ${name} needs rung a, b, or c.`);
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
