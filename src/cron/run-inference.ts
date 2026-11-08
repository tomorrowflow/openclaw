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
  /** Account params for the recorded account's provider. */
  runParams: CronRunInferenceParams;
  /** Account params for one candidate's provider; call only after `assertCandidate` admitted it. */
  runParamsFor: (provider: string) => CronRunInferenceParams;
  assertCandidate: (provider: string, cliExecution: boolean) => void;
  /**
   * A CLI candidate may run only when its backend forwards exactly the recorded account,
   * selected explicitly; `resolve` is the same selector interactive CLI turns use.
   */
  resolveCliAuthProfile: (
    resolve: (selected: {
      authProfileId: string;
      authProfileIdSource: "user";
    }) => Promise<string | undefined>,
  ) => Promise<string>;
  dispose: () => void;
};

function incompatibleCandidateError(
  cliExecution: boolean,
  fallbackWithoutAccount: boolean,
  cause?: unknown,
): Error {
  return new Error(
    "Automation candidate is incompatible with its recorded inference account and route. " +
      (cliExecution
        ? "The selected runtime uses a CLI login that cannot use this job's stored account. "
        : "The selected model uses a different provider from this job's stored account. ") +
      "Select a model compatible with the recorded account, or explicitly select a stored account with " +
      "openclaw automations edit <jobId> --model <provider/model>@<profileId>." +
      (fallbackWithoutAccount || cliExecution
        ? ""
        : " To let bound jobs fall back to models that use no stored account (for example Ollama), set cron.allowFallbackWithoutAccount to true."),
    cause === undefined ? undefined : { cause },
  );
}

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
  const runParams: CronRunInferenceParams = {
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
    runParams,
    runParamsFor: (provider) =>
      provider === binding.provider ? runParams : { automationFallbackWithoutAccount: true },
    assertCandidate(provider, cliExecution) {
      if (provider === binding.provider) {
        // CLI candidates finish this check in resolveCliAuthProfile, before the process starts.
        authorization.assertCurrent();
        return;
      }
      // Fallback without an account covers host-managed runtimes only; CLI logins stay refused.
      if (fallbackWithoutAccount && !cliExecution) {
        return;
      }
      throw incompatibleCandidateError(cliExecution, fallbackWithoutAccount);
    },
    async resolveCliAuthProfile(resolve) {
      let profileId: string | undefined;
      try {
        profileId = await resolve({
          authProfileId: binding.profileId,
          authProfileIdSource: "user",
        });
      } catch (error) {
        throw incompatibleCandidateError(true, fallbackWithoutAccount, error);
      }
      if (profileId !== binding.profileId) {
        throw incompatibleCandidateError(true, fallbackWithoutAccount);
      }
      authorization.assertCurrent();
      return profileId;
    },
    dispose: authorization.dispose,
  };
}
