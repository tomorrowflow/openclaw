import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { describe, expect, it, vi } from "vitest";
import {
  createSubscribedSessionHarness,
  emitAssistantTextDelta,
  emitAssistantTextEnd,
  extractTextPayloads,
} from "./embedded-agent-subscribe.e2e-harness.js";
import { textAssistant } from "./test-helpers/sparse-transcript.test-support.js";

// Chat templates that prefill <think> (GLM, Qwen) stream the reasoning body and
// its close tag with no opening tag. A tool-call turn ends at that close tag, so
// nothing after it marks the reasoning as hidden.
const REASONING_CHUNKS = [
  "This is a heartbeat monitor check. Let me follow the checklist:\n\n",
  "1. Inbox: check the vault for pending items.\n\n",
  "Nothing is due. Let me proceed.",
];
const ANSWER = "Two work events start at 16:00 and overlap.";

function createHarness(runId: string) {
  const onBlockReply = vi.fn();
  const { emit, subscription } = createSubscribedSessionHarness({
    runId,
    onBlockReply,
    blockReplyBreak: "message_end",
    blockReplyChunking: { minChars: 16, maxChars: 128, breakPreference: "paragraph" },
  });
  return { emit, onBlockReply, subscription };
}

describe("template-prefilled reasoning", () => {
  it("delivers nothing when a tool-call turn ends at the orphan close tag", async () => {
    const { emit, onBlockReply, subscription } = createHarness("run-orphan-tool-turn");
    const source = `${REASONING_CHUNKS.join("")}</think>`;

    emit({ type: "message_start", message: { role: "assistant" } });
    for (const delta of [...REASONING_CHUNKS, "</think>"]) {
      emitAssistantTextDelta({ emit, delta });
    }
    emitAssistantTextEnd({ emit, content: source });
    emit({ type: "message_end", message: textAssistant(source) as AssistantMessage });
    await subscription.waitForPendingEvents();

    expect(extractTextPayloads(onBlockReply.mock.calls)).toEqual([]);
    subscription.unsubscribe();
  });

  it("delivers only the answer that follows the orphan close tag", async () => {
    const { emit, onBlockReply, subscription } = createHarness("run-orphan-final-turn");
    const source = `${REASONING_CHUNKS.join("")}</think>${ANSWER}`;

    emit({ type: "message_start", message: { role: "assistant" } });
    for (const delta of [...REASONING_CHUNKS, "</think>", ANSWER]) {
      emitAssistantTextDelta({ emit, delta });
    }
    emitAssistantTextEnd({ emit, content: source });
    emit({ type: "message_end", message: textAssistant(source) as AssistantMessage });
    await subscription.waitForPendingEvents();

    expect(extractTextPayloads(onBlockReply.mock.calls).join("")).toBe(ANSWER);
    subscription.unsubscribe();
  });
});
