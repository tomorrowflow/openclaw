import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import {
  createLazyRuntimeModule,
  createLazyRuntimeSurface,
} from "openclaw/plugin-sdk/lazy-runtime";
import type {
  OpenClawConfig,
  ProviderRuntimeModel,
  ProviderWrapStreamFnContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { findNormalizedProviderValue } from "openclaw/plugin-sdk/provider-auth";
import {
  createMoonshotThinkingWrapper,
  DEFAULT_CONTEXT_TOKENS,
  normalizeProviderId,
  resolveMoonshotThinkingType,
} from "openclaw/plugin-sdk/provider-model-shared";
import { isLoopbackHost } from "openclaw/plugin-sdk/ssrf-runtime";
import { supportsOllamaCloudFullThinkingEffort } from "./model-reasoning.js";
import { isOllamaCloudKimiModelRef } from "./sanitizers/kimi-inline-reasoning.js";

export type OllamaThinkValue = boolean | "low" | "medium" | "high" | "max";

const loadProviderStreamRuntime = createLazyRuntimeModule(
  () => import("openclaw/plugin-sdk/provider-stream-shared"),
);

function createLazyPayloadPatchStreamWrapper(
  baseFn: StreamFn | undefined,
  patchPayload: Parameters<
    (typeof import("openclaw/plugin-sdk/provider-stream-shared"))["createPayloadPatchStreamWrapper"]
  >[1],
): StreamFn {
  const loadStream = createLazyRuntimeSurface(loadProviderStreamRuntime, (runtime) =>
    runtime.createPayloadPatchStreamWrapper(baseFn, patchPayload),
  );
  return async (model, context, options) => {
    options?.signal?.throwIfAborted();
    const stream = await loadStream();
    options?.signal?.throwIfAborted();
    return stream(model, context, options);
  };
}

export function resolveConfiguredOllamaProviderConfig(params: {
  config?: OpenClawConfig;
  providerId?: string;
}) {
  const providerId = params.providerId?.trim();
  if (!providerId) {
    return undefined;
  }
  const providers = params.config?.models?.providers;
  return providers?.[providerId] ?? findNormalizedProviderValue(providers, providerId);
}

export function isOllamaCompatProvider(model: {
  provider?: string;
  baseUrl?: string;
  api?: string;
}): boolean {
  const providerId = normalizeProviderId(model.provider ?? "");
  if (providerId === "ollama") {
    return true;
  }
  if (!model.baseUrl) {
    return false;
  }
  try {
    const parsed = new URL(model.baseUrl);
    if (isLoopbackHost(parsed.hostname) && parsed.port === "11434") {
      return true;
    }

    // Allow remote/LAN Ollama OpenAI-compatible endpoints when the provider id
    // itself indicates Ollama usage (for example "my-ollama").
    const providerHintsOllama = providerId.includes("ollama");
    const isOllamaPort = parsed.port === "11434";
    const isOllamaCompatPath = parsed.pathname === "/" || /^\/v1\/?$/i.test(parsed.pathname);
    return providerHintsOllama && isOllamaPort && isOllamaCompatPath;
  } catch {
    return false;
  }
}

export function resolveOllamaCompatNumCtxEnabled(params: {
  config?: OpenClawConfig;
  providerId?: string;
}): boolean {
  return resolveConfiguredOllamaProviderConfig(params)?.injectNumCtxForOpenAICompat ?? true;
}

export function shouldInjectOllamaCompatNumCtx(params: {
  model: { api?: string; provider?: string; baseUrl?: string };
  config?: OpenClawConfig;
  providerId?: string;
}): boolean {
  if (params.model.api !== "openai-completions") {
    return false;
  }
  if (!isOllamaCompatProvider(params.model)) {
    return false;
  }
  return resolveOllamaCompatNumCtxEnabled({
    config: params.config,
    providerId: params.providerId,
  });
}

export function wrapOllamaCompatNumCtx(baseFn: StreamFn | undefined, numCtx: number): StreamFn {
  return createLazyPayloadPatchStreamWrapper(baseFn, ({ payload }) => {
    if (!payload.options || typeof payload.options !== "object") {
      payload.options = {};
    }
    (payload.options as Record<string, unknown>).num_ctx = numCtx;
  });
}

// Ollama's OpenAI-compatible endpoint requires tool-call arguments to remain
// JSON strings; only its native chat transport accepts object arguments.
function ensureArgsString(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === undefined || value === null) {
    return "{}";
  }
  return JSON.stringify(value);
}

function normalizeOllamaCompatMessageToolArgs(payloadRecord: Record<string, unknown>): void {
  const messages = payloadRecord.messages;
  if (!Array.isArray(messages)) {
    return;
  }
  for (const message of messages) {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      continue;
    }
    // SAFETY: the non-array object guard above establishes a record-like message payload.
    const messageRecord = message as Record<string, unknown>;
    const functionCall = messageRecord.function_call;
    if (functionCall && typeof functionCall === "object" && !Array.isArray(functionCall)) {
      // SAFETY: the non-array object guard above establishes a record-like function call.
      const functionCallRecord = functionCall as Record<string, unknown>;
      if (Object.hasOwn(functionCallRecord, "arguments")) {
        functionCallRecord.arguments = ensureArgsString(functionCallRecord.arguments);
      }
    }
    const toolCalls = messageRecord.tool_calls;
    if (!Array.isArray(toolCalls)) {
      continue;
    }
    for (const toolCall of toolCalls) {
      if (!toolCall || typeof toolCall !== "object" || Array.isArray(toolCall)) {
        continue;
      }
      // SAFETY: the non-array object guard above establishes a record-like tool call.
      const functionSpec = (toolCall as Record<string, unknown>).function;
      if (!functionSpec || typeof functionSpec !== "object" || Array.isArray(functionSpec)) {
        continue;
      }
      // SAFETY: the non-array object guard above establishes a record-like function spec.
      const functionRecord = functionSpec as Record<string, unknown>;
      if (Object.hasOwn(functionRecord, "arguments")) {
        functionRecord.arguments = ensureArgsString(functionRecord.arguments);
      }
    }
  }
}

function wrapOllamaCompatMessageToolArgs(baseFn: StreamFn | undefined): StreamFn {
  return createLazyPayloadPatchStreamWrapper(baseFn, ({ payload }) => {
    // SAFETY: the payload patch helper passes the mutable JSON request object.
    normalizeOllamaCompatMessageToolArgs(payload as Record<string, unknown>);
  });
}

function createOllamaThinkingWrapper(
  baseFn: StreamFn | undefined,
  think: OllamaThinkValue,
): StreamFn {
  return createLazyPayloadPatchStreamWrapper(baseFn, ({ payload }) => {
    payload.think = think;
  });
}

function normalizeOllamaThinkValue(
  value: unknown,
  nativeMax: boolean,
): OllamaThinkValue | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (value === "off") {
    return false;
  }
  if (value === "low" || value === "medium" || value === "high") {
    return value;
  }
  if (value === "max") {
    // Verified full-effort Cloud families accept native max. Keep the shipped
    // high fallback for local and model-specific contracts without that tier.
    return nativeMax ? "max" : "high";
  }
  if (value === "minimal") {
    return "low";
  }
  if (value === "xhigh" || value === "adaptive") {
    // These OpenClaw-only tiers are not advertised by Ollama; keep their established high mapping.
    return "high";
  }
  return undefined;
}

export function resolveOllamaThinkParamValue(
  params: Record<string, unknown> | undefined,
  nativeMax = false,
): OllamaThinkValue | undefined {
  return normalizeOllamaThinkValue(params?.think ?? params?.thinking, nativeMax);
}

export function supportsNativeOllamaMax(
  model: Pick<ProviderRuntimeModel, "id" | "provider"> | undefined,
  providerId?: string,
): boolean {
  const isCloudProvider =
    normalizeProviderId(model?.provider ?? "") === "ollama-cloud" ||
    normalizeProviderId(providerId ?? "") === "ollama-cloud";
  return isCloudProvider && supportsOllamaCloudFullThinkingEffort(model?.id ?? "");
}

export function shouldForwardNativeOllamaThink(
  model: ProviderRuntimeModel | undefined,
  think: OllamaThinkValue,
): boolean {
  // Ollama accepts top-level `think` as the native chat contract, but rejects
  // truthy values for models known not to expose thinking support.
  return think === false || model?.reasoning !== false;
}

export function resolveOllamaConfiguredNumCtx(model: ProviderRuntimeModel): number | undefined {
  const raw = model.params?.num_ctx;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    return undefined;
  }
  return Math.floor(raw);
}

function resolveOllamaNumCtx(model: ProviderRuntimeModel): number {
  return (
    resolveOllamaConfiguredNumCtx(model) ??
    Math.max(
      1,
      Math.floor(
        model.contextTokens ?? model.contextWindow ?? model.maxTokens ?? DEFAULT_CONTEXT_TOKENS,
      ),
    )
  );
}

export function createConfiguredOllamaCompatStreamWrapper(
  ctx: ProviderWrapStreamFnContext,
): StreamFn | undefined {
  let streamFn = ctx.streamFn;
  const model = ctx.model;
  const isNativeOllamaTransport = model?.api === "ollama";

  if (model) {
    const providerId =
      typeof model.provider === "string" && model.provider.trim().length > 0
        ? model.provider
        : ctx.provider;
    if (
      shouldInjectOllamaCompatNumCtx({
        model,
        config: ctx.config,
        providerId,
      })
    ) {
      streamFn = wrapOllamaCompatNumCtx(streamFn, resolveOllamaNumCtx(model));
    }
  }
  if (model?.api === "openai-completions") {
    streamFn = wrapOllamaCompatMessageToolArgs(streamFn);
  }

  const nativeMax = supportsNativeOllamaMax(model, ctx.provider);
  const configuredThinkValue = model
    ? resolveOllamaThinkParamValue(model.params, nativeMax)
    : undefined;
  const runtimeThinkValue = isNativeOllamaTransport
    ? normalizeOllamaThinkValue(ctx.thinkingLevel, nativeMax)
    : undefined;
  // "off" is also the implicit agent default. Preserve explicit native Ollama
  // model config unless the active run requests a non-off thinking level.
  const ollamaThinkValue =
    runtimeThinkValue === false && configuredThinkValue !== undefined
      ? undefined
      : runtimeThinkValue;
  if (ollamaThinkValue !== undefined && shouldForwardNativeOllamaThink(model, ollamaThinkValue)) {
    streamFn = createOllamaThinkingWrapper(streamFn, ollamaThinkValue);
  }

  if (normalizeProviderId(ctx.provider) === "ollama" && isOllamaCloudKimiModelRef(ctx.modelId)) {
    const thinkingType = resolveMoonshotThinkingType({
      configuredThinking: ctx.extraParams?.thinking,
      thinkingLevel: ctx.thinkingLevel,
    });
    streamFn = createMoonshotThinkingWrapper(streamFn, thinkingType);
  }

  return streamFn;
}
