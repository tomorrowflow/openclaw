import { describe, expect, it } from "vitest";
import { stripReasoningTagsFromText } from "./reasoning-tags.js";

describe("stripReasoningTagsFromText", () => {
  describe("basic functionality", () => {
    it.each([
      [
        "never recovers nested unclosed internal reflection as visible text",
        "<thinking>outer<internal>private reflection",
        "",
      ],
    ] as const)("%s", (_name, input, expected) => {
      expect(stripReasoningTagsFromText(input)).toBe(expected);
    });
  });

  describe("code block preservation (issue #3952)", () => {
    it.each<[string, string, string?]>([
      [
        "preserves final tags inside code examples",
        "Use `<final>` for final answers in code:\n```\n<final>42</final>\n```",
      ],
      [
        "strips real tags after fenced code block",
        "```\n<think>code</think>\n```\n<think>real hidden</think>visible",
        "```\n<think>code</think>\n```\nvisible",
      ],
    ] as const)("%s", (_name, input, expected) => {
      expect(stripReasoningTagsFromText(input)).toBe(expected ?? input);
    });
  });

  describe("edge cases", () => {
    it.each([
      [
        "Here is how to use <think tags in your code",
        "Here is how to use <think tags in your code",
      ],
      // An unfenced trailing close tag costs this sentence its visible text. The
      // realistic way to write one is fenced, which the code-span cases below keep,
      // and a close tag mid-sentence already retracted the prose before it.
      ["You can start with <think and then close with </think>", ""],
      ["Internal reasoning </think> final answer", "final answer"],
      // Templates that prefill <think> emit only the body and its close tag, so a
      // tool-call turn ends at the orphan close with no answer after it.
      ["Let me check the inbox first.</think>", ""],
      ["Reasoning one</think>Reasoning two</think>", ""],
      ["</think>Answer only", "Answer only"],
      ["<reasoning>outer<think>secret</think>", ""],
      ["A < think >content< /think > B", "A  B"],
      ["", ""],
    ] as const)("handles malformed or empty input %j", (input, expected) => {
      expect(stripReasoningTagsFromText(input)).toBe(expected);
    });

    it.each([
      ["A <final/>visible <final data-model='gemini'>answer</final> B", "A visible answer B"],
      ["  <final-result>visible</final-result>  ", "  <final-result>visible</final-result>  "],
      ['A <final reason="a>b">visible B', 'A <final reason="a>b">visible B'],
    ] as const)("handles nested/final tag behavior: %j", (input, expected) => {
      expect(stripReasoningTagsFromText(input)).toBe(expected);
    });
  });

  describe("strict vs preserve mode", () => {
    it.each([
      [
        "keeps strict mode from leaking unclosed trailing reasoning after visible text",
        "Before <think>unclosed content after",
        "Before",
        { mode: "strict" as const },
      ],
      [
        "does not recover internal reflection in preserve mode",
        "<internal>private reflection",
        "",
        { mode: "preserve" as const },
      ],
    ] as const)("%s", (_name, input, expected, opts) => {
      expect(stripReasoningTagsFromText(input, opts)).toBe(expected);
    });
  });

  describe("trim options", () => {
    it.each([
      [
        "keeps final-only whitespace with trim=none",
        "  <final>result</final>  ",
        "  result  ",
        { trim: "none" as const },
      ],
      [
        "supports trim=start",
        "  <think>x</think>  result  ",
        "result  ",
        { trim: "start" as const },
      ],
    ] as const)("%s", (_name, input, expected, opts) => {
      expect(stripReasoningTagsFromText(input, opts)).toBe(expected);
    });
  });
});
