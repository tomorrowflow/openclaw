import { afterEach, expect, it, vi } from "vitest";
import * as modelRuntime from "../agents/embedded-agent-runner/model.js";
import { prepareEmbeddedRunAuthPlan } from "../agents/embedded-agent-runner/run/auth-plan.js";
import type { AgentHarness } from "../agents/harness/types.js";
import { makeProviderModelFixture } from "../agents/test-helpers/provider-model-fixture.js";
import type { Model } from "../llm/types.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";

const harness: AgentHarness = {
  id: "openclaw",
  label: "Synthetic scheduled auth",
  supports: () => ({ supported: true }),
  runAttempt: async () => {
    throw new Error("Auth preparation must not contact a provider");
  },
};
type FixtureModel = Model<"openai-responses" | "bedrock-converse-stream" | "ollama">;
const model = makeProviderModelFixture<"openai-responses">({
  id: "gpt-4.1",
  provider: "openai",
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
  maxTokens: 1_024,
});
afterEach(() => vi.restoreAllMocks());

function prepareAuth(
  state: OpenClawTestState,
  stores: ReturnType<typeof modelRuntime.createEmptyAgentDiscoveryStores>,
  runParams: Partial<Parameters<typeof prepareEmbeddedRunAuthPlan>[0]["runParams"]>,
  selectedModel: FixtureModel = model,
  nativeModelOwned = false,
) {
  return withPluginRuntimeGenerationScope(
    { metadataSnapshot: createPluginMetadataSnapshotFixture() },
    () =>
      prepareEmbeddedRunAuthPlan({
        assertCurrent() {},
        runParams: {
          sessionId: "scheduled-fire",
          runId: "scheduled-fire",
          workspaceDir: state.workspaceDir,
          prompt: "Synthetic scheduled work",
          timeoutMs: 1_000,
          trigger: "cron",
          config: {},
          ...runParams,
        },
        provider: selectedModel.provider,
        modelId: selectedModel.id,
        model: selectedModel,
        agentDir: state.agentDir(),
        workspaceDir: state.workspaceDir,
        nativeModelOwned,
        nativeSessionRuntime: nativeModelOwned
          ? { auth: "native", harness, assertCurrent: async () => {} }
          : undefined,
        ...stores,
        getAgentHarness: () => harness,
        setAgentHarness() {},
        getRuntimeModel: () => selectedModel,
        getEffectiveModel: () => selectedModel,
        applyResolvedRuntimeModel() {},
        selectHarnessForPreparedAttempts: () => harness,
      }),
  );
}

function withAuthState(callback: (state: OpenClawTestState) => Promise<void>, ambientKey?: string) {
  return withOpenClawTestState(
    { label: "scheduled-auth", env: { OPENAI_API_KEY: ambientKey } },
    async (state) => {
      await state.writeAuthProfiles({ version: 1, profiles: {} });
      await callback(state);
    },
  );
}

function mockModel(selectedModel: FixtureModel = model) {
  const stores = modelRuntime.createEmptyAgentDiscoveryStores();
  vi.spyOn(modelRuntime, "resolveModelAsync").mockResolvedValue({
    ...stores,
    model: selectedModel,
    logicalRef: { provider: selectedModel.provider, model: selectedModel.id },
  });
  return stores;
}

function configFor(selectedModel: FixtureModel, auth: { apiKey: string } | { auth: "aws-sdk" }) {
  const provider = { api: selectedModel.api, baseUrl: selectedModel.baseUrl, models: [], ...auth };
  return { models: { providers: { [selectedModel.provider]: provider } } };
}

const bedrockModel: FixtureModel = {
  ...model,
  id: "anthropic.claude-sonnet",
  provider: "amazon-bedrock",
  api: "bedrock-converse-stream",
  baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
};

// Stored-profile refusal is exercised through provider HTTP in auth-continuity.integration.
it("refuses legacy adoption from ambient AWS SDK credentials at the auth boundary", async () => {
  await withAuthState(async (state) => {
    const materialize = vi.spyOn(modelRuntime, "resolveModelAsync");
    const stores = modelRuntime.createEmptyAgentDiscoveryStores();
    await expect(
      prepareAuth(
        state,
        stores,
        { config: configFor(bedrockModel, { auth: "aws-sdk" }) },
        bedrockModel,
      ),
    ).rejects.toThrow("Automation has no recorded inference account");
    expect(materialize).not.toHaveBeenCalled();
  });
});

it.each([
  ["configured", "event", "provider-config"],
  ["native", "cron", undefined],
  ["credentialless", "cron", undefined],
  ["synthetic-marker", "cron", "synthetic"],
] as const)(
  "keeps %s %s auth without adopting an ambient host account",
  async (kind, trigger, evidence) => {
    await withAuthState(
      async (state) => {
        const selectedModel: FixtureModel =
          kind === "native" || kind === "configured"
            ? model
            : { ...model, provider: "ollama", api: "ollama", baseUrl: "http://localhost:11434" };
        const prepared = await prepareAuth(
          state,
          mockModel(selectedModel),
          {
            trigger,
            config: evidence
              ? configFor(selectedModel, {
                  apiKey: kind === "configured" ? "synthetic-configured-event-key" : "ollama-local",
                })
              : {},
          },
          selectedModel,
          kind === "native",
        );
        expect(prepared.preparedAuthAttempts).toMatchObject(
          evidence
            ? [{ kind: "direct", plan: { credentialSource: { kind: "direct", evidence } } }]
            : [{ kind: "implicit" }],
        );
        expect(prepared.lockedProfileId).toBeUndefined();
      },
      kind === "configured" ? undefined : "synthetic-ambient-key",
    );
  },
);

it.each([
  { route: "config-declared", admitted: true },
  { route: "credentialless", admitted: true },
  { route: "stored-profile", admitted: false },
  { route: "ambient-env", admitted: false },
  { route: "harness-owned", admitted: false },
  { route: "native-session", admitted: false },
] as const)(
  "decides an opted-in account-free fallback on a $route route (admitted: $admitted)",
  async ({ route, admitted }) => {
    await withOpenClawTestState(
      {
        label: "cron-fallback-without-account",
        env: { OPENAI_API_KEY: route === "ambient-env" ? "synthetic-ambient-key" : undefined },
      },
      async (state) => {
        await state.writeAuthProfiles({
          version: 1,
          profiles:
            route === "stored-profile"
              ? {
                  "ollama:cloud": {
                    type: "api_key",
                    provider: "ollama",
                    key: "synthetic-stored-key",
                  },
                }
              : {},
        });
        const fallbackModel: Model =
          route === "ambient-env"
            ? model
            : {
                ...model,
                id: "glm-5.3:cloud",
                provider: "ollama",
                api: "ollama",
                baseUrl: "http://127.0.0.1:11434",
              };
        const stores = modelRuntime.createEmptyAgentDiscoveryStores();
        vi.spyOn(modelRuntime, "resolveModelAsync").mockResolvedValue({
          ...stores,
          model: fallbackModel,
          logicalRef: { provider: fallbackModel.provider, model: fallbackModel.id },
        });
        const fallbackHarness: AgentHarness =
          route === "harness-owned" ? { ...harness, authBootstrap: "harness" } : harness;
        const prepare = () =>
          withPluginRuntimeGenerationScope(
            { metadataSnapshot: createPluginMetadataSnapshotFixture() },
            () =>
              prepareEmbeddedRunAuthPlan({
                assertCurrent() {},
                runParams: {
                  sessionId: "fallback-fire",
                  runId: "fallback-fire",
                  workspaceDir: state.workspaceDir,
                  prompt: "Synthetic fallback work",
                  timeoutMs: 1_000,
                  trigger: "cron",
                  automationFallbackWithoutAccount: true,
                  config:
                    route === "config-declared"
                      ? {
                          models: {
                            providers: {
                              ollama: {
                                api: "ollama",
                                apiKey: "synthetic-declared-key",
                                baseUrl: fallbackModel.baseUrl,
                                models: [],
                              },
                            },
                          },
                        }
                      : {},
                },
                provider: fallbackModel.provider,
                modelId: fallbackModel.id,
                model: fallbackModel,
                agentDir: state.agentDir(),
                workspaceDir: state.workspaceDir,
                nativeModelOwned: false,
                ...stores,
                ...(route === "native-session"
                  ? {
                      nativeSessionRuntime: {
                        auth: "native" as const,
                        harness,
                        assertCurrent: async () => {},
                      },
                    }
                  : {}),
                getAgentHarness: () => fallbackHarness,
                setAgentHarness() {},
                getRuntimeModel: () => fallbackModel,
                getEffectiveModel: () => fallbackModel,
                applyResolvedRuntimeModel() {},
                selectHarnessForPreparedAttempts: () => harness,
              }),
          );

        if (admitted) {
          const prepared = await prepare();
          expect(prepared.preparedAuthAttempts.map(({ kind }) => kind)).not.toContain("profile");
          expect(prepared.lockedProfileId).toBeUndefined();
        } else {
          await expect(prepare()).rejects.toThrow(
            route === "native-session"
              ? "A native connection cannot replace"
              : "would use a stored, ambient, or runtime-owned account",
          );
        }
      },
    );
  },
);
