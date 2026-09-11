// Runs the isolated settled-tool finalization through the real built-in harness
// and embedded attempt runner against a loopback provider, so the request the
// finalizer actually sends is the proof.
import fs from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { writeOpenAiResponsesText } from "../../../../test/helpers/openai-responses-sse.js";
import type { Model } from "../../../llm/types.js";
import type { AgentMessage } from "../../runtime/index.js";
import { AuthStorage } from "../../sessions/auth-storage.js";
import { ModelRegistry } from "../../sessions/model-registry.js";
import {
  buildEmbeddedRunnerAssistant,
  createResolvedEmbeddedRunnerModel,
} from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { installEmbeddedRunnerBaseE2eMocks } from "../../test-helpers/embedded-agent-runner-e2e-mocks.js";
import {
  createSettledFinalizationTestInput,
  createSettledProviderFailureAttempt,
  projectSettledProviderFailureAttempt,
} from "./settled-turn-finalization.test-support.js";

let prepareTerminalWithSettledTurnFinalization: typeof import("./settled-turn-finalization.js").prepareTerminalWithSettledTurnFinalization;
let createOpenClawAgentHarness: typeof import("../../harness/builtin-openclaw.js").createOpenClawAgentHarness;
let prepareSystemAgentRunAdmission: typeof import("../../admitted-run-context.js").prepareSystemAgentRunAdmission;
let replaceSessionEntry: typeof import("../../../config/sessions/session-accessor.js").replaceSessionEntry;
let appendMessage: typeof import("../../../plugin-sdk/session-transcript-runtime.js").appendSessionTranscriptMessageByIdentity;

beforeAll(async () => {
  installEmbeddedRunnerBaseE2eMocks({ hookRunner: "full" });
  // The real transport path links the full provider-hook binding surface; keep
  // every export present and provider-plugin free.
  vi.doMock("../../../plugins/provider-hook-runtime.js", () => ({
    attachModelProviderRuntimePluginHandle: (model: unknown) => model,
    getModelProviderRuntimePluginHandle: vi.fn(() => undefined),
    resolveLoadedProviderPluginsForHooks: vi.fn(() => undefined),
    resolveProviderPluginsForHooks: vi.fn(() => []),
    resolveProviderRuntimePlugin: vi.fn(() => undefined),
    resolveLoadedProviderRuntimePlugin: vi.fn(() => undefined),
    resolveProviderHookPlugin: vi.fn(() => undefined),
    resolveProviderRuntimePluginHandle: vi.fn((params: object) => params),
    ensureProviderRuntimePluginHandle: vi.fn(() => ({ plugin: undefined })),
    resolveProviderAuthProfileId: vi.fn(() => undefined),
    resolveProviderFollowupFallbackRoute: vi.fn(() => undefined),
    wrapProviderSimpleCompletionStreamFn: vi.fn(() => undefined),
    prepareProviderExtraParams: vi.fn(() => undefined),
    resolveProviderExtraParamsForTransport: vi.fn(() => undefined),
    wrapProviderStreamFn: vi.fn(() => undefined),
    clearProviderRuntimePluginCacheForTest: vi.fn(),
  }));
  vi.doMock("../../models-config.js", () => ({
    ensureOpenClawModelsJson: vi.fn(async () => ({ wrote: false })),
  }));
  ({ prepareTerminalWithSettledTurnFinalization } = await import("./settled-turn-finalization.js"));
  ({ createOpenClawAgentHarness } = await import("../../harness/builtin-openclaw.js"));
  ({ prepareSystemAgentRunAdmission } = await import("../../admitted-run-context.js"));
  ({ replaceSessionEntry } = await import("../../../config/sessions/session-accessor.js"));
  ({ appendSessionTranscriptMessageByIdentity: appendMessage } =
    await import("../../../plugin-sdk/session-transcript-runtime.js"));
});

let admission: ReturnType<typeof prepareSystemAgentRunAdmission>;
let root: string;
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "settled-builtin-")));
  admission = prepareSystemAgentRunAdmission({}, "run-settled", "main", "loopback-finalizer");
});
afterEach(async () => {
  admission.close();
  await fs.rm(root, { recursive: true, force: true });
});

function writeOpenAiChatCompletionSse(response: ServerResponse, text: string): void {
  const chunk = (delta: Record<string, unknown>, finish: string | null, usage?: unknown) =>
    `data: ${JSON.stringify({
      id: "chatcmpl-final",
      object: "chat.completion.chunk",
      created: 1,
      model: "test-model",
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...(usage ? { usage } : {}),
    })}\n\n`;
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(
    chunk({ role: "assistant", content: text }, null) +
      chunk({}, "stop", { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 }) +
      "data: [DONE]\n\n",
  );
}

it.each(["openai-responses", "openai-completions"] as const)(
  "resumes the settled tool batch in the finalizer request over %s",
  async (api) => {
    const requests: unknown[] = [];
    const server = createServer((request, response) => {
      request.setEncoding("utf8");
      let body = "";
      request.on("data", (chunk: string) => {
        body += chunk;
      });
      request.on("end", () => {
        requests.push(JSON.parse(body));
        if (api === "openai-completions") {
          writeOpenAiChatCompletionSse(response, "Note saved once.");
          return;
        }
        writeOpenAiResponsesText(response, {
          text: "Note saved once.",
          messageId: "msg_final",
          responseId: "resp_final",
        });
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Missing loopback address");
      }
      const agentDir = path.join(root, "agents", "main", "agent");
      const workspaceDir = path.join(root, "workspace");
      await Promise.all([fs.mkdir(agentDir, { recursive: true }), fs.mkdir(workspaceDir)]);
      const resolved = createResolvedEmbeddedRunnerModel("loopback-provider", "test-model", {
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
      });
      const authStorage = AuthStorage.inMemory();
      authStorage.setRuntimeApiKey("loopback-provider", "synthetic-loopback-key");
      const modelRegistry = ModelRegistry.inMemory(authStorage);
      const model: Model = {
        ...resolved.model,
        api,
        provider: "loopback-provider",
        input: ["text"],
        contextWindow: 200_000,
        maxTokens: 4096,
      };
      const target = {
        agentId: "main",
        sessionId: "session-settled",
        sessionKey: "agent:main:settled",
        storePath: path.join(agentDir, "openclaw-agent.sqlite"),
      };
      await replaceSessionEntry(target, { sessionId: target.sessionId, updatedAt: 1 });
      const messages: AgentMessage[] = [
        { role: "user", content: "Write the note", timestamp: 1 },
        buildEmbeddedRunnerAssistant({
          stopReason: "toolUse",
          content: [{ type: "toolCall", id: "call-write", name: "write", arguments: {} }],
        }),
        {
          role: "toolResult",
          toolCallId: "call-write",
          toolName: "write",
          content: [{ type: "text", text: "Note saved to notes.md" }],
          isError: false,
          timestamp: 3,
        },
        buildEmbeddedRunnerAssistant({
          stopReason: "error",
          errorMessage: "upstream connect error: connection refused",
          errorCode: "ECONNREFUSED",
        } as never),
      ];
      for (const message of messages) {
        await appendMessage({ ...target, config: {}, message });
      }
      const attempt = projectSettledProviderFailureAttempt(
        createSettledProviderFailureAttempt({
          terminal: { kind: "ok" },
          sessionIdUsed: target.sessionId,
          messagesSnapshot: messages,
          toolMetas: [
            { toolName: "write", toolCallId: "call-write", isError: false, replaySafe: false },
          ],
          itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
        }),
      );
      expect(attempt).toMatchObject({
        settledTurnFinalizationContext: { source: "openclaw-transcript" },
      });
      const input = createSettledFinalizationTestInput(attempt, await admission.admit("embedded"));
      input.terminalBase.runParams.trigger = "user";
      input.terminalBase.runParams.config = {};
      input.terminalBase.provider = model.provider;
      input.terminalBase.model = model.id;
      input.terminalBase.activeErrorContext = { provider: model.provider, model: model.id };
      input.finalization.modelApi = model.api;
      Object.assign(input.finalization.preparedAttempt, resolved, {
        authStorage,
        modelRegistry,
        model,
        config: {},
        provider: model.provider,
        modelId: model.id,
        resolvedApiKey: "synthetic-loopback-key",
        agentId: target.agentId,
        sessionKey: target.sessionKey,
        sessionTarget: target,
        sessionFile: target.sessionKey,
        workspaceDir,
        agentDir,
        // The finalizer reopens the session through a byte cap derived from this
        // budget. Sized for a fresh turn, that view cannot hold the settled tool
        // batch; the finalizer must answer from the settled snapshot instead.
        contextTokenBudget: 100,
        authProfileStore: { version: 1, profiles: {} },
      });
      input.finalization.harness = createOpenClawAgentHarness();

      const result = await prepareTerminalWithSettledTurnFinalization(input);

      expect(result.finalizationOutcome).toBe("answered");
      expect(requests).toHaveLength(1);
      const serialized = JSON.stringify(requests[0]);
      expect(serialized).toContain("Write the note");
      expect(serialized).toContain("Note saved to notes.md");
      expect(serialized).toContain("did not produce a user-visible answer");
      expect(result.prepared.payloadsWithToolMedia).toEqual([
        expect.objectContaining({ text: "Note saved once." }),
      ]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  },
);
