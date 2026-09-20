// Coverage for a settled tool batch that ends in a bare "stop" with no content:
// the batch owner proves settlement, but only a turn that owes a visible reply
// may reopen the model's terminal decision.
import { describe, expect, it } from "vitest";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { resolveEmbeddedRunAttemptTerminalState } from "./terminal-outcome.js";
import { resolveSettledTurnFinalizationRequest } from "./terminal-resolution.js";

const SETTLED_TOOL_TERMINAL_CONTINUATION_INSTRUCTION =
  "The previous assistant turn completed its tool calls but did not produce a user-visible answer. Continue from the current transcript and produce the final user-visible answer now. Do not repeat completed tool calls or restart from scratch. Tools are unavailable in this step: it is a text-only pass, so reply with plain text and do not attempt any tool call.";

describe("resolveSettledTurnFinalizationRequest with a content-less post-tool stop", () => {
  // Observed on a heartbeat poll: the model settles its tool batch, then ends
  // with a "stop" message that carries no content blocks. The batch evidence
  // resolves the earlier tool-use message as the batch owner; that owner must
  // not reopen the visible-reply gate an optional turn never had.
  const toolUseAssistant = buildEmbeddedRunnerAssistant({
    stopReason: "toolUse",
    content: [{ type: "toolCall", id: "tool-1", name: "write", arguments: {} }],
  });
  const emptyStopAssistant = buildEmbeddedRunnerAssistant({ stopReason: "stop", content: [] });
  const attempt = makeEmbeddedRunnerAttempt({
    assistantTexts: [],
    toolMetas: [{ toolName: "write", toolCallId: "tool-1", replaySafe: false }],
    itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
    messagesSnapshot: [
      { role: "user", content: [{ type: "text", text: "[OpenClaw heartbeat poll]" }] },
      toolUseAssistant,
      { role: "toolResult", toolCallId: "tool-1", toolName: "write", isError: false },
      emptyStopAssistant,
    ] as never,
    lastAssistant: emptyStopAssistant,
    currentAttemptAssistant: emptyStopAssistant,
    currentAttemptCompletedAssistant: emptyStopAssistant,
    replayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
    currentAttemptReplayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
  });
  const request = (runParams: {
    trigger: "heartbeat" | "user";
    terminalReplyExpectation?: "required";
  }) =>
    resolveSettledTurnFinalizationRequest({
      runParams: {
        sessionId: "session:settled-empty-stop",
        runId: "run:settled-empty-stop",
        ...runParams,
      } as never,
      attempt,
      activeErrorContext: { provider: "openai", model: "gpt-5.6-luna" },
      modelApi: "openai-completions",
      executionContract: undefined,
      payloadsWithToolMedia: [],
      hasTerminalToolPresentation: false,
      terminalState: resolveEmbeddedRunAttemptTerminalState({
        attempt,
        assistant: emptyStopAssistant,
      }),
      settledTurnFinalizationAvailable: true,
    });

  it("keeps a heartbeat's terminal stop silent even though a tool-use message owns the batch", () => {
    expect(request({ trigger: "heartbeat" })).toBeNull();
  });

  it("still continues a required user turn that produced no visible answer", () => {
    expect(request({ trigger: "user", terminalReplyExpectation: "required" })).toBe(
      SETTLED_TOOL_TERMINAL_CONTINUATION_INSTRUCTION,
    );
  });
});
