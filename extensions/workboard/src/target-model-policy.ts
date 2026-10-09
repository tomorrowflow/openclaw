import { resolveDefaultAgentId } from "openclaw/plugin-sdk/agent-scope-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";

/** Returns core's refusal reason when `agentId` may not run `model`, else undefined. */
export type WorkboardTargetModelCheck = (params: {
  agentId?: string;
  model: string;
}) => string | undefined;

/**
 * Core model policy owns the verdict; Workboard asks it when a board target is
 * saved so a disallowed model fails there instead of at the first dispatch.
 */
export function createWorkboardTargetModelCheck(runtime: {
  config: Pick<PluginRuntime["config"], "current">;
  modelConfig: Pick<
    PluginRuntime["modelConfig"],
    "resolveAllowedModelRef" | "resolveDefaultModelForAgent"
  >;
}): WorkboardTargetModelCheck {
  return ({ agentId, model }) => {
    // The model-selection readers only read the snapshot; their SDK types predate DeepReadonly.
    const cfg = runtime.config.current() as OpenClawConfig;
    const resolvedAgentId = agentId ?? resolveDefaultAgentId(cfg);
    const defaultModel = runtime.modelConfig.resolveDefaultModelForAgent({
      cfg,
      agentId: resolvedAgentId,
    });
    const allowed = runtime.modelConfig.resolveAllowedModelRef({
      cfg,
      catalog: [],
      raw: model,
      defaultProvider: defaultModel.provider,
      defaultModel: defaultModel.model,
      agentId: resolvedAgentId,
    });
    return "error" in allowed ? allowed.error : undefined;
  };
}
