import { describe, expect, it } from "vitest";
import { createCliJsonlStreamingParser } from "./cli-output-stream.js";

function streamDelta(delta: Record<string, unknown>, index = 0) {
  return {
    type: "stream_event",
    event: { type: "content_block_delta", index, delta },
    uuid: "11111111-1111-4111-8111-111111111111",
    session_id: "22222222-2222-4222-8222-222222222222",
    parent_tool_use_id: null,
  };
}

function messageStart(id: string) {
  return { type: "stream_event", event: { type: "message_start", message: { id } } };
}

function toolBlockStart(index: number, id: string, input: Record<string, unknown> = {}) {
  return {
    type: "stream_event",
    event: {
      type: "content_block_start",
      index,
      content_block: { type: "tool_use", id, name: "Write", input },
    },
  };
}

function blockStop(index: number) {
  return { type: "stream_event", event: { type: "content_block_stop", index } };
}

const openToolBlock = toolBlockStart(0, "tool-0");

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
    // One 2 MB payload fits however many copies the parser keeps of it; a
    // stream of them within one message is bounded by the 8 MiB budget.
    const line = `${JSON.stringify(streamDelta({ type, [field]: "a".repeat(2_000_000) }))}\n`;
    parser.push(line);
    expect(parser.getErrorText()).toBeNull();
    for (let pushes = 1; pushes < 5 && !parser.getErrorText(); pushes += 1) {
      parser.push(line);
    }
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

  it("frees streamed tool input at block stop so long tool-heavy turns stay within budget", () => {
    const starts: string[] = [];
    const parser = createCliJsonlStreamingParser({
      backend: { command: "claude", output: "jsonl", jsonlDialect: "claude-stream-json" },
      providerId: "claude-cli",
      onAssistantDelta: () => {},
      onToolUseStart: (tool) => starts.push(tool.toolCallId),
    });
    const push = (record: unknown) => parser.push(`${JSON.stringify(record)}\n`);
    // 30 Write calls of 300 KB each stream 9 MB of input over the turn while at
    // most one block's input is pending at a time.
    const content = "a".repeat(300_000);
    for (let round = 0; round < 30; round += 1) {
      push(messageStart(`msg-${round}`));
      push(toolBlockStart(0, `write-${round}`));
      push(streamDelta({ type: "input_json_delta", partial_json: '{"content":"' }));
      push(streamDelta({ type: "input_json_delta", partial_json: content }));
      push(streamDelta({ type: "input_json_delta", partial_json: '"}' }));
      push(blockStop(0));
    }
    push(messageStart("final"));
    push(streamDelta({ type: "text_delta", text: "done" }));
    push({ type: "result", subtype: "success", result: "done" });
    parser.finish();

    expect(parser.getErrorText()).toBeNull();
    expect(parser.getOutput()?.text).toBe("done");
    expect(starts).toHaveLength(30);
  });

  it("charges tool input carried on content_block_start until the block stops", () => {
    const parser = createParser();
    const push = (record: unknown) => parser.push(`${JSON.stringify(record)}\n`);
    push(messageStart("msg-0"));
    // 40 blocks at distinct indexes never stop, so every start snapshot stays pending.
    for (let index = 0; index < 40 && !parser.getErrorText(); index += 1) {
      push(toolBlockStart(index, `write-${index}`, { content: "a".repeat(300_000) }));
    }
    expect(parser.getErrorText()).toContain("Gateway parse budget");
  });

  it("frees native thinking when the next message starts", () => {
    const parser = createParser();
    const push = (record: unknown) => parser.push(`${JSON.stringify(record)}\n`);
    // 20 messages stream 20 MB of thinking in total while each message holds 1 MB.
    for (let round = 0; round < 20; round += 1) {
      push(messageStart(`msg-${round}`));
      push({
        type: "stream_event",
        event: { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
      });
      push(streamDelta({ type: "thinking_delta", thinking: "t".repeat(1_000_000) }));
      push(blockStop(0));
    }
    push(messageStart("final"));
    push(streamDelta({ type: "text_delta", text: "done" }));
    push({ type: "result", subtype: "success", result: "done" });
    parser.finish();

    expect(parser.getErrorText()).toBeNull();
    expect(parser.getOutput()?.text).toBe("done");
  });

  it("charges tool names retained from custom tool result events", () => {
    const parser = createCliJsonlStreamingParser({
      backend: { command: "custom-cli", output: "jsonl" },
      providerId: "custom-cli",
      parseJsonlEvent: (line) => JSON.parse(line),
      onAssistantDelta: () => {},
      onToolResult: () => {},
    });
    for (let index = 0; index < 10 && !parser.getErrorText(); index += 1) {
      parser.push(
        `${JSON.stringify({
          kind: "toolResult",
          toolCallId: `call-${index}`,
          name: "n".repeat(1_000_000),
          result: "ok",
        })}\n`,
      );
    }
    expect(parser.getErrorText()).toContain("Gateway parse budget");
  });

  it("holds a streamed reply twice at most when the result repeats it", () => {
    const parser = createParser();
    const push = (record: unknown) => parser.push(`${JSON.stringify(record)}\n`);
    // 3 MB streamed in one message and repeated by the result: the reply text
    // and the result text stay charged, the message's own copy is refunded at
    // the result, so 6 MB of the 8 MiB budget is held and the reply survives.
    const reply = "r".repeat(3_000_000);
    push(messageStart("reply"));
    push(streamDelta({ type: "text_delta", text: reply }));
    push({ type: "result", subtype: "success", result: reply });
    parser.finish();

    expect(parser.getErrorText()).toBeNull();
    expect(parser.getOutput()?.text).toBe(reply);
  });

  it("does not charge deltas the parser drops", () => {
    const parser = createParser();
    // No open tool block: the input JSON is dropped, so 12 MB of it retains nothing.
    const line = `${JSON.stringify(streamDelta({ type: "input_json_delta", partial_json: "a".repeat(4_000_000) }))}\n`;
    parser.push(`${line}${line}${line}`);
    expect(parser.getErrorText()).toBeNull();
  });
});
