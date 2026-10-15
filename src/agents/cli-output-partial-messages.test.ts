import { describe, expect, it } from "vitest";
import { createCliJsonlStreamingParser } from "./cli-output-stream.js";

function streamDelta(delta: Record<string, unknown>) {
  return {
    type: "stream_event",
    event: { type: "content_block_delta", index: 0, delta },
    uuid: "11111111-1111-4111-8111-111111111111",
    session_id: "22222222-2222-4222-8222-222222222222",
    parent_tool_use_id: null,
  };
}

const openToolBlock = {
  type: "stream_event",
  event: {
    type: "content_block_start",
    index: 0,
    content_block: { type: "tool_use", id: "tool-0", name: "Write", input: {} },
  },
};

function createParser() {
  return createCliJsonlStreamingParser({
    backend: { command: "claude", output: "jsonl", jsonlDialect: "claude-stream-json" },
    providerId: "claude-cli",
    onAssistantDelta: () => {},
    onThinkingDelta: () => {},
  });
}

describe("Claude partial-message output budgets", () => {
  it.each([
    { name: "envelope characters", count: 18_000, chars: 128, resultChars: 2_000_000 },
    { name: "delta frames", count: 20_001, chars: 1, resultChars: 0 },
  ])(
    "delivers completed tool turns through long $name streams",
    ({ count, chars, resultChars }) => {
      const inputs: unknown[] = [];
      const parser = createCliJsonlStreamingParser({
        backend: { command: "claude", output: "jsonl", jsonlDialect: "claude-stream-json" },
        providerId: "claude-cli",
        onAssistantDelta: () => {},
        onToolUseStart: (tool) => inputs.push(tool.args),
      });
      const push = (record: unknown) => parser.push(`${JSON.stringify(record)}\n`);
      const input = { value: "a".repeat(count * chars) };
      const tool = { type: "tool_use", id: "write-fixture", name: "Write", input };
      push({
        type: "stream_event",
        event: { type: "content_block_start", index: 0, content_block: { ...tool, input: {} } },
      });
      push(streamDelta({ type: "input_json_delta", partial_json: '{"value":"' }));
      const chunk = `${JSON.stringify(streamDelta({ type: "input_json_delta", partial_json: "a".repeat(chars) }))}\n`;
      for (let index = 0; index < count; index += 1) {
        parser.push(chunk);
      }
      push(streamDelta({ type: "input_json_delta", partial_json: '"}' }));
      push({ type: "stream_event", event: { type: "content_block_stop", index: 0 } });
      push({ type: "assistant", message: { id: "tool-message", content: [tool] } });
      push({
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: tool.id, content: "r".repeat(resultChars) },
          ],
        },
      });
      push({
        type: "assistant",
        message: { id: "final-message", content: [{ type: "text", text: "completed" }] },
      });
      push({ type: "result", subtype: "success", result: "completed" });
      parser.finish();

      expect(parser.getErrorText()).toBeNull();
      expect(parser.hasTerminalResult()).toBe(true);
      expect(parser.getOutput()?.text).toBe("completed");
      expect(inputs).toEqual([input]);
    },
  );

  it.each([
    { type: "text_delta", field: "text" },
    { type: "thinking_delta", field: "thinking" },
    { type: "input_json_delta", field: "partial_json" },
  ])("still bounds retained $type payloads", ({ type, field }) => {
    const parser = createParser();
    parser.push(`${JSON.stringify(openToolBlock)}\n`);
    const line = `${JSON.stringify(streamDelta({ type, [field]: "a".repeat(4_300_000) }))}\n`;
    parser.push(line);
    expect(parser.getErrorText()).toBeNull();
    parser.push(line);
    expect(parser.getErrorText()).toContain("Gateway parse budget");
    expect(parser.getOutput()?.text).toBe("");
  });

  it.each([
    { type: "text_delta", text: "a" },
    { type: "thinking_delta", thinking: "a", estimated_tokens: null },
  ])("accepts a long $type stream without a terminal frame", (delta) => {
    const parser = createParser();
    parser.push(`${JSON.stringify(streamDelta(delta))}\n`.repeat(20_001));
    parser.finish();
    expect(parser.getErrorText()).toBeNull();
    expect(parser.getOutput()).not.toBeNull();
    if (delta.type === "text_delta") {
      expect(parser.getOutput()?.text).toBe("a".repeat(20_001));
    }
  });

  it("bounds tiny retained delta floods through the per-append overhead", () => {
    const parser = createParser();
    parser.push(`${JSON.stringify(openToolBlock)}\n`);
    const line = `${JSON.stringify(streamDelta({ type: "input_json_delta", partial_json: "a" }))}\n`;
    for (let index = 0; index < 262_145 && !parser.getErrorText(); index += 1) {
      parser.push(line);
    }
    expect(parser.getErrorText()).toContain("Gateway parse budget");
  });

  it("does not charge deltas the parser drops", () => {
    const parser = createParser();
    // No open tool block: the input JSON is dropped, so 12 MB of it retains nothing.
    const line = `${JSON.stringify(streamDelta({ type: "input_json_delta", partial_json: "a".repeat(4_000_000) }))}\n`;
    parser.push(`${line}${line}${line}`);
    expect(parser.getErrorText()).toBeNull();
  });
});
