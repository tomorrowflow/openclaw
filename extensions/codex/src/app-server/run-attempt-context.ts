import {
  bootstrapHarnessContextEngine,
  buildAgentHookContextChannelFields,
  buildHarnessContextEngineRuntimeContext,
  CODEX_APP_SERVER_CONTEXT_ENGINE_HOST,
  embeddedAgentLog,
  getAgentHarnessHookRunner,
  isHostScopedAgentToolActive,
  resolveContextEngineOwnerPluginId,
  runHarnessContextEngineMaintenance,
  type AgentMessage,
  type EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  buildCodexOpenClawPromptContext,
  buildCodexWatchedSessionsContext,
  readMirroredSessionHistoryMessages,
  renderCodexSkillsInstructions,
} from "./attempt-context.js";
import { buildCodexWorkspaceBootstrapContext } from "./attempt-workspace-context.js";
import {
  resolveCodexContextEngineProjectionMaxChars,
  resolveCodexContinuityProjectionMaxChars,
  type CodexProjectedContextRange,
} from "./context-engine-projection.js";
import { joinPresentSections } from "./developer-instruction-sections.js";
import { isSystemAgentOnlyCodexDynamicToolAllowlist } from "./dynamic-tool-profile.js";
import type { CodexAttemptRuntime } from "./run-attempt-runtime.js";
import type { CodexAttemptTools } from "./run-attempt-tool-setup.js";
import {
  buildDeveloperInstructions,
  type CodexContextEngineThreadBootstrapProjection,
} from "./thread-lifecycle.js";

// Accepted steering rewrites the transcript and rotates its generation, so a same-run
// retry can no longer read through the original admission. The fenced read ends before
// that admission and excludes this run's own results, so the first attempt's snapshot
// is exactly what a reread would return. Keyed by recorder: one logical run's lifetime.
// Context-engine bootstrap and assembly still read through the receipt; their engine-owned
// effects are not cacheable here, so those retries keep failing closed until core refreshes it.
const retainedFencedHistories = new WeakMap<
  NonNullable<EmbeddedRunAttemptParams["userTurnTranscriptRecorder"]>,
  { scope: string; messages: AgentMessage[] }
>();

export async function prepareCodexAttemptContext(
  runtime: CodexAttemptRuntime,
  attemptTools: CodexAttemptTools,
) {
  const {
    connection,
    runtimeParams,
    effectiveContextWindowInfo,
    effectiveContextTokenBudget,
    effectiveRuntimeProviderId,
    effectiveRuntimeModelId,
    hookChannelId,
  } = runtime;
  const {
    params,
    sessionAgentId,
    contextSessionKey,
    activeContextEngine,
    initialStartupBindingHadInactiveThreadBootstrap,
    effectiveWorkspace,
    effectiveCwd,
    agentDir,
    usesSupervisionConnection,
    resolvedWorkspace,
    initialInactiveThreadBootstrapBindingForcedFreshStart,
    sandbox,
  } = connection;
  const { toolBridge } = attemptTools;
  const activeTranscriptTarget = {
    agentId: sessionAgentId,
    sessionFile: runtimeParams.sessionFile,
    sessionId: runtimeParams.sessionId,
    sessionKey: contextSessionKey,
    sessionTarget: params.sessionTarget,
  };
  const readFencedHistory = async () => {
    const transcriptReadFence = params.userTurnTranscriptRecorder?.getAdmissionReceipt();
    const messages = await readMirroredSessionHistoryMessages({
      ...activeTranscriptTarget,
      signal: connection.runAbortController.signal,
      contextTokenBudget: effectiveContextTokenBudget,
      ...(transcriptReadFence ? { admission: transcriptReadFence } : {}),
    });
    connection.runAbortController.signal.throwIfAborted();
    connection.assertCurrent();
    return messages;
  };
  const readRetainedFencedHistory = async () => {
    const recorder = params.userTurnTranscriptRecorder;
    const admission = recorder?.getAdmissionReceipt();
    if (!recorder || !admission) {
      return await readFencedHistory();
    }
    const scope = JSON.stringify([
      params.runId,
      admission.entryId,
      activeTranscriptTarget.agentId,
      activeTranscriptTarget.sessionId,
      activeTranscriptTarget.sessionKey,
      activeTranscriptTarget.sessionFile,
      params.sessionTarget?.storePath,
      effectiveContextTokenBudget,
    ]);
    const retained = retainedFencedHistories.get(recorder);
    if (retained?.scope === scope) {
      connection.runAbortController.signal.throwIfAborted();
      connection.assertCurrent();
      return [...retained.messages];
    }
    retainedFencedHistories.delete(recorder);
    const messages = await readFencedHistory();
    if (messages) {
      retainedFencedHistories.set(recorder, { scope, messages: [...messages] });
    }
    return messages;
  };
  const historyState = {
    messages:
      !activeContextEngine && initialStartupBindingHadInactiveThreadBootstrap
        ? []
        : ((await readRetainedFencedHistory()) ?? []),
  };
  const hadSessionTranscriptState = historyState.messages.length > 0;
  const hookContextWindowFields = {
    ...(effectiveContextWindowInfo?.tokens
      ? { contextTokenBudget: effectiveContextWindowInfo.tokens }
      : effectiveContextTokenBudget
        ? { contextTokenBudget: effectiveContextTokenBudget }
        : {}),
    ...(effectiveContextWindowInfo?.source
      ? { contextWindowSource: effectiveContextWindowInfo.source }
      : {}),
    ...(effectiveContextWindowInfo?.referenceTokens
      ? { contextWindowReferenceTokens: effectiveContextWindowInfo.referenceTokens }
      : {}),
  };
  const hookContext = {
    runId: params.runId,
    agentId: sessionAgentId,
    sessionKey: contextSessionKey,
    sessionId: params.sessionId,
    workspaceDir: params.workspaceDir,
    // Native-owned models are confirmed after startup; hooks must not publish
    // stale bindings or private transport overrides as the selected model.
    ...(!usesSupervisionConnection &&
    connection.mutable.startupBinding?.preserveNativeModel !== true
      ? { modelProviderId: params.provider, modelId: params.modelId }
      : {}),
    trigger: params.trigger,
    inputProvenance: params.inputProvenance,
    ...buildAgentHookContextChannelFields({
      sessionKey: contextSessionKey,
      messageChannel: params.messageChannel,
      messageProvider: params.messageProvider,
      currentChannelId: hookChannelId,
      messageTo: params.messageTo,
      senderId: params.senderId,
      agentAccountId: params.agentAccountId,
    }),
    channelContext: params.channelContext,
    ...hookContextWindowFields,
  };
  const hookRunner = getAgentHarnessHookRunner();
  const buildActiveContextEngineRuntimeContext = () =>
    buildHarnessContextEngineRuntimeContext({
      attempt: { ...runtimeParams },
      workspaceDir: effectiveWorkspace,
      cwd: effectiveCwd,
      agentDir,
      activeAgentId: sessionAgentId,
      contextEnginePluginId: resolveContextEngineOwnerPluginId(activeContextEngine),
      tokenBudget: effectiveContextTokenBudget,
    });
  if (activeContextEngine) {
    await bootstrapHarnessContextEngine({
      hadSessionFile: hadSessionTranscriptState,
      contextEngine: activeContextEngine,
      sessionId: runtimeParams.sessionId,
      sessionKey: contextSessionKey,
      sessionFile: runtimeParams.sessionFile,
      sessionTarget: params.sessionTarget,
      runtimeContext: buildActiveContextEngineRuntimeContext(),
      transcriptReadFence: params.userTurnTranscriptRecorder?.getAdmissionReceipt(),
      contextEngineHostSupport: CODEX_APP_SERVER_CONTEXT_ENGINE_HOST,
      providerId: effectiveRuntimeProviderId,
      requestedModelId: usesSupervisionConnection ? undefined : params.requestedModelId,
      modelId: effectiveRuntimeModelId,
      fallbackReason: usesSupervisionConnection ? undefined : params.fallbackReason,
      degradedReason: usesSupervisionConnection ? undefined : params.degradedReason,
      runMaintenance: runHarnessContextEngineMaintenance,
      config: params.config,
      warn: (message) => embeddedAgentLog.warn(message),
    });
    historyState.messages = (await readFencedHistory()) ?? historyState.messages;
  }
  // The admission fence intentionally excludes this logical turn's committed results.
  historyState.messages.push(...(params.pluginRuntimeRefreshMessages ?? []));
  const workspaceBootstrapContext = await buildCodexWorkspaceBootstrapContext({
    params: runtimeParams,
    agentWorkspaceDeveloperInstructions:
      connection.mutable.startupBinding?.agentWorkspaceDeveloperInstructions,
    resolvedWorkspace: runtimeParams.bootstrapWorkspaceDir ?? resolvedWorkspace,
    executionWorkspace: resolvedWorkspace,
    effectiveWorkspace,
    sessionKey: contextSessionKey,
    sessionAgentId,
    tools: toolBridge.availableSpecs,
    ringZeroActive:
      isHostScopedAgentToolActive("openclaw") &&
      isSystemAgentOnlyCodexDynamicToolAllowlist(runtimeParams.toolsAllow),
    sandboxed: sandbox?.enabled === true,
  });
  const agentWorkspaceDeveloperInstructions = workspaceBootstrapContext.threadDeveloperInstructions;
  const skillsInstructions = renderCodexSkillsInstructions({
    attempt: runtimeParams,
    skillsPrompt: params.skillsSnapshot?.prompt,
  });
  const baseDeveloperInstructions = joinPresentSections(
    buildDeveloperInstructions(runtimeParams, {
      dynamicTools: toolBridge.availableSpecs,
    }),
    agentWorkspaceDeveloperInstructions,
  );
  const watchedSessionsContext = buildCodexWatchedSessionsContext({
    attempt: runtimeParams,
    dynamicTools: toolBridge.availableSpecs,
    sessionKey: contextSessionKey,
    sandboxed: sandbox?.enabled === true,
  });
  const buildOpenClawPromptContext = (includeWorkspaceReferences: boolean) =>
    buildCodexOpenClawPromptContext({
      params: runtimeParams,
      workspacePromptContext: includeWorkspaceReferences
        ? workspaceBootstrapContext.promptContext
        : undefined,
      watchedSessionsContext,
    });
  const promptState = {
    promptText: params.prompt,
    promptContextRange: undefined as CodexProjectedContextRange | undefined,
    developerInstructions: baseDeveloperInstructions,
    contextEngineProjection: undefined as CodexContextEngineThreadBootstrapProjection | undefined,
    precomputedStaleBindingContinuityProjectionApplied: false,
    staleBindingContinuityForcedFreshStart: false,
    // Set by the no-engine continuity appliers; gates calibration recording so a
    // dense direct or active-engine prompt can never persist a density sample
    // that later shrinks continuity history it did not measure.
    noEngineContinuityProjectionApplied: false,
    inactiveThreadBootstrapBindingForcedFreshStart:
      initialInactiveThreadBootstrapBindingForcedFreshStart,
  };
  const codexContextProjectionMaxChars = resolveCodexContextEngineProjectionMaxChars({
    contextTokenBudget: effectiveContextTokenBudget,
  });
  const codexContinuityProjectionMaxChars = resolveCodexContinuityProjectionMaxChars({
    contextTokenBudget: effectiveContextTokenBudget,
    calibration: connection.mutable.continuityCalibration,
  });
  return {
    runtime,
    attemptTools,
    activeTranscriptTarget,
    historyState,
    hookContext,
    hookContextWindowFields,
    hookRunner,
    buildActiveContextEngineRuntimeContext,
    workspaceBootstrapContext,
    agentWorkspaceDeveloperInstructions,
    baseDeveloperInstructions,
    buildOpenClawPromptContext,
    skillsInstructions,
    promptState,
    codexContextProjectionMaxChars,
    codexContinuityProjectionMaxChars,
  };
}

export type CodexAttemptContext = Awaited<ReturnType<typeof prepareCodexAttemptContext>>;
