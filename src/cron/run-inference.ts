import type { RunEmbeddedAgentInternalParams } from "../agents/embedded-agent-runner/run/internal-params.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { CronInferenceBinding } from "./inference-binding.js";

type CronRunInferenceParams = Pick<
  RunEmbeddedAgentInternalParams,
  | "authProfileId"
  | "authProfileBinding"
  | "allowAuthProfileFallback"
  | "onSuccessfulAuthProfile"
  | "authProfileIdSource"
  | "automationFallbackWithoutAccount"
>;

export type CronRunInference = {
  /** Account params for one candidate's provider; call only after `assertCandidate` admitted it. */
  runParamsFor: (provider: string) => CronRunInferenceParams;
  assertCandidate: (provider: string, cliExecution: boolean) => void;
  dispose: () => void;
};

/** Both Cron execution paths keep the recorded account bound through turn settlement. */
export async function prepareCronRunInference(params: {
  binding?: CronInferenceBinding;
  cfg: OpenClawConfig;
  agentDir: string;
}): Promise<CronRunInference | undefined> {
  const { binding } = params;
  if (!binding) {
    return undefined;
  }
  const { acquireCronInferenceAuthorization } = await import("./inference-binding.runtime.js");
  const authorization = await acquireCronInferenceAuthorization({ ...params, binding });
  const fallbackWithoutAccount = params.cfg.cron?.allowFallbackWithoutAccount === true;
  const boundParams: CronRunInferenceParams = {
    authProfileId: binding.profileId,
    authProfileBinding: {
      profileId: binding.profileId,
      authRequirement: binding.authRequirement,
      assertCurrent: authorization.assertCurrent,
      revalidate: authorization.revalidate,
    },
    allowAuthProfileFallback: false,
    onSuccessfulAuthProfile: (profileId) => {
      if (profileId !== binding.profileId) {
        throw new Error("Automation inference account changed during execution.");
      }
    },
    authProfileIdSource: binding.source,
  };
  return {
    runParamsFor: (provider) =>
      provider === binding.provider ? boundParams : { automationFallbackWithoutAccount: true },
    assertCandidate(provider, cliExecution) {
      if (provider === binding.provider && !cliExecution) {
        authorization.assertCurrent();
        return;
      }
      if (fallbackWithoutAccount && !cliExecution) {
        return;
      }
      throw new Error(describeIncompatibleCandidate(cliExecution, fallbackWithoutAccount));
    },
    dispose: authorization.dispose,
  };
}

function describeIncompatibleCandidate(
  cliExecution: boolean,
  fallbackWithoutAccount: boolean,
): string {
  return (
    "Automation candidate is incompatible with its recorded inference account and route. " +
    (cliExecution
      ? "The selected runtime uses a CLI login, which cannot replace this job's stored account. "
      : "The selected model uses a different provider from this job's stored account. ") +
    "Select a model compatible with the recorded account, or explicitly select a stored account with " +
    "openclaw automations edit <jobId> --model <provider/model>@<profileId> using a host-managed runtime." +
    (fallbackWithoutAccount || cliExecution
      ? ""
      : " To let bound jobs fall back to models that use no stored account (for example Ollama), set cron.allowFallbackWithoutAccount to true.")
  );
}
