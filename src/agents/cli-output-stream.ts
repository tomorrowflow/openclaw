import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { formatErrorMessage } from "../infra/errors.js";
import type {
  CliBackendParseJsonlEvent,
  CliBackendParsedJsonlEvent,
} from "../plugins/cli-backend.types.js";
import type {
  CliJsonlStreamingParserOptions,
  CliOutput,
  CliUsage,
} from "./cli-output-contracts.js";
import { normalizeClaudeCliStreamJsonRecord } from "./cli-output-echoed-binary.js";
import type { CliEventProjectionState } from "./cli-output-events.js";
import {
  createLeadingTaggedReasoningRouter,
  createThinkingTracker,
  createToolUseTracker,
  dispatchClaudeCliStreamingToolEvent,
  dispatchClaudeCliThinking,
  dispatchGeminiCliStreamingToolEvent,
  partitionLeadingTaggedReasoning,
  projectCliBackendEvent,
  projectCliTaggedReasoning,
} from "./cli-output-events.js";
import * as cliOutputLifecycle from "./cli-output-lifecycle.js";
import {
  decodeCliRecords,
  isClaudeStopHookFeedbackRecord,
  isClaudeStreamJsonDialect,
  isClaudeSyntheticNoResponse,
  isClaudeSubagentRecord,
  isClaudeToolUseBlockType,
  isGeminiStreamJsonDialect,
  missingMessageBoundarySeparator,
  parseClaudeCliJsonlResult,
  parseClaudeCliStreamingDelta,
  pickCliResumeCheckpointId,
  pickCliSessionId,
  preferGeminiCliStreamJsonError,
  readClaudeAttributedSubagentProgressId,
  preferStreamedClaudeTextOverResult,
  readCliUsage,
  readGeminiCliStreamJsonError,
  supportsCliJsonlToolEvents,
} from "./cli-output-records.js";
import { appendCliResultText, recordItemText, withCliRawFinalText } from "./cli-output-results.js";
import {
  CLI_STREAM_JSON_OUTPUT_LIMITS,
  createRetainedOutputLedger,
  frameBoundedCliJsonlChunk,
  streamJsonOutputLimitErrorText,
} from "./cli-output-stream-limits.js";
import { resolveCliStreamOutput } from "./cli-output-stream-output.js";
export { CLI_STREAM_JSON_MISSING_RESULT_ERROR } from "./cli-output-stream-output.js";
const CLAUDE_SYNTHETIC_NO_RESPONSE_ERROR = "Claude CLI returned a synthetic no-response result.";

export function createCliJsonlStreamingParser(params: CliJsonlStreamingParserOptions) {
  const lineBuffer = { pending: "" };
  let assistantText = "";
  let customThinkingText = "";
  let pendingClaudeText = "";
  let currentClaudeMessageId: string | undefined;
  let currentClaudeMessageText = "";
  let pendingMessageSeparator = false;
  let currentMessageStart = 0;
  let segmentStart = 0;
  // Streamed text from this offset on is still a candidate to outrank the
  // result envelope; every non-tool boundary or interim result restarts it.
  let preserveFrom = 0;
  // Commentary-buffered text skips emitClaudeVisibleText's boundary handling;
  // this diagnostics-only offset marks where its current message starts.
  let flushedMessageStart = 0;
  let sawToolUseSinceText = false;
  let currentMessageHadToolUse = false;
  let previousMessageHadToolUse = false;
  let sessionId: string | undefined;
  let resumeCheckpointId: string | undefined;
  let usage: CliUsage | undefined;
  let diagnosticUsage: CliUsage | undefined;
  let output: CliOutput | null = null;
  let parseErrorText = "";
  let rawLines = 0;
  const texts: string[] = [];
  // The last item text is the final message only until a later message or tool
  // call begins; boundary flags set before that text must not blank it.
  let finalItemText: string | undefined;
  let sawCustomJsonlEvent = false;
  let sawGeminiStructuredOutput = false;
  let sawTerminalResult = false;
  let sawClaudeSyntheticNoResponse = false;
  const outputLimits = CLI_STREAM_JSON_OUTPUT_LIMITS;
  // The turn budget is a live gauge of what this parser holds: reply text,
  // result text, and tool ids live for the turn; the message's snapshot diff
  // base, tagged reasoning, native thinking, and pending tool input are
  // refunded when their message or block ends. Records the parser hands off
  // and drops (tool results, system records, subagent traffic) only meet the
  // per-line limit, so long tool-heavy turns stay within budget.
  const ledger = createRetainedOutputLedger(outputLimits.maxTurnRetainedChars, () => {
    if (!parseErrorText) {
      parseErrorText = streamJsonOutputLimitErrorText(
        "retained",
        outputLimits.maxTurnRetainedChars,
      );
      lineBuffer.pending = "";
    }
  });
  const messageRetained = ledger.scope();
  const commentaryRetained = ledger.scope();
  const toolTracker = createToolUseTracker(ledger);
  // Classification is keyed on consumer presence so reclassified pre-tool text
  // always has a destination; a separate enable flag let it be dropped (#92092).
  const classifyClaudeCommentary =
    Boolean(params.onCommentaryText) && supportsCliJsonlToolEvents(params);
  const thinkingTracker = createThinkingTracker(ledger);
  const claudeStreamJson = isClaudeStreamJsonDialect(params);
  let taggedReasoningRouter = createLeadingTaggedReasoningRouter(ledger.scope());
  let currentTaggedReasoningText = "";

  const appendAssistantText = (delta: string) => {
    ledger.retain(delta.length);
    assistantText += delta;
    params.onAssistantDelta({ text: assistantText, delta, sessionId, usage });
  };

  const flushPendingClaudeText = (kind: "assistant" | "commentary") => {
    if (!pendingClaudeText) {
      return;
    }
    const text = kind === "commentary" ? pendingClaudeText.trim() : pendingClaudeText;
    pendingClaudeText = "";
    commentaryRetained.release();
    if (kind === "assistant") {
      // A flushed assistant segment after a boundary starts a fresh
      // final-message segment; commentary routing never touches it.
      if (pendingMessageSeparator || sawToolUseSinceText) {
        flushedMessageStart = assistantText.length;
      }
      pendingMessageSeparator = false;
      sawToolUseSinceText = false;
      appendAssistantText(text);
    } else if (text) {
      params.onCommentaryText?.(text);
    }
  };

  const emitClaudeVisibleText = (delta: string) => {
    if (!delta) {
      return;
    }
    if (classifyClaudeCommentary) {
      commentaryRetained.retain(delta.length);
      pendingClaudeText = `${pendingClaudeText}${delta}`;
      return;
    }
    // A tool_use block starts a new post-tool segment even inside one assistant
    // message; only tool-split boundaries may later outrank the result envelope.
    // A message boundary is a tool split only when the PREVIOUS message used a
    // tool: a tool-first fresh message must not connect an earlier draft, while
    // a tool-using message keeps its text connected across its own boundary.
    const boundaryPending = pendingMessageSeparator || sawToolUseSinceText;
    const isToolSplitBoundary = pendingMessageSeparator
      ? previousMessageHadToolUse
      : sawToolUseSinceText;
    const separator =
      boundaryPending && assistantText ? missingMessageBoundarySeparator(assistantText, delta) : "";
    if (boundaryPending && assistantText) {
      currentMessageStart = assistantText.length + separator.length;
      // Text before a non-tool boundary may be a superseded draft; only text
      // connected to the result through tool splits stays a candidate.
      if (!isToolSplitBoundary) {
        preserveFrom = currentMessageStart;
      }
    }
    pendingMessageSeparator = false;
    sawToolUseSinceText = false;
    appendAssistantText(`${separator}${delta}`);
  };

  const setTaggedReasoningText = (text: string) => {
    if (text.length > currentTaggedReasoningText.length) {
      messageRetained.retain(text.length - currentTaggedReasoningText.length);
    }
    currentTaggedReasoningText = text;
  };

  const routeTaggedReasoningDeltas = (
    deltas: Parameters<typeof projectCliTaggedReasoning>[0]["deltas"],
  ) => {
    setTaggedReasoningText(
      projectCliTaggedReasoning({
        deltas,
        currentText: currentTaggedReasoningText,
        hasNativeThinking: Boolean(thinkingTracker.emittedText),
        onThinkingDelta: params.onThinkingDelta,
        onVisibleText: emitClaudeVisibleText,
      }),
    );
  };

  const finishTaggedReasoningMessage = () => {
    if (claudeStreamJson) {
      routeTaggedReasoningDeltas(taggedReasoningRouter.finish());
    }
  };

  // A result or the next message start ends the current message: its snapshot
  // diff base and tagged reasoning are dropped and their charges refunded.
  // Returns the ended message's tagged reasoning so a result can skip re-emitting it.
  const endClaudeMessage = () => {
    finishTaggedReasoningMessage();
    const endedTaggedReasoningText = currentTaggedReasoningText;
    messageRetained.release();
    currentTaggedReasoningText = "";
    currentClaudeMessageText = "";
    return endedTaggedReasoningText;
  };

  const beginClaudeMessage = (messageId?: string) => {
    endClaudeMessage();
    taggedReasoningRouter = createLeadingTaggedReasoningRouter(ledger.scope());
    pendingMessageSeparator = true;
    finalItemText = undefined;
    previousMessageHadToolUse = currentMessageHadToolUse;
    currentMessageHadToolUse = false;
    currentClaudeMessageId = messageId;
  };

  // Diagnostics need the model's final message alone; `text` stays the
  // cumulative delivery reply. The final message is the last streamed segment,
  // empty when a new message began or a tool call followed its last text.
  const finalStreamedMessageText = () =>
    finalItemText?.trim() ??
    (pendingMessageSeparator || sawToolUseSinceText
      ? ""
      : assistantText.slice(Math.max(currentMessageStart, flushedMessageStart)).trim());

  const handleCustomJsonlEvent = (event: CliBackendParsedJsonlEvent) => {
    const previousOutput = output;
    const state: CliEventProjectionState = {
      assistantText,
      customThinkingText,
      sessionId,
      usage,
      output,
      sawCustomJsonlEvent,
    };
    projectCliBackendEvent({
      ...params,
      event,
      state,
      texts,
      toolTracker,
      ledger,
    });
    ({ assistantText, customThinkingText, sessionId, usage, output, sawCustomJsonlEvent } = state);
    // Custom events carry no message boundaries: a tool start begins the next
    // final-message segment, so pre-tool narration is never the final message.
    if (event.kind === "toolStart") {
      currentMessageStart = assistantText.length;
    } else if (event.kind === "result" && output && !output.errorText) {
      // A metadata-only result keeps the earlier result's final message.
      const prior = previousOutput?.rawFinalText ?? previousOutput?.text.trim();
      const finalText = event.text?.trim() || (prior ?? finalStreamedMessageText());
      output = withCliRawFinalText(output, finalText);
    }
  };

  const observeSessionId = (parsed: Record<string, unknown>) => {
    const parsedSessionId = pickCliSessionId(parsed, params.backend);
    if (parsedSessionId && parsedSessionId !== sessionId) {
      sessionId = parsedSessionId;
      params.onSessionId?.(parsedSessionId);
    }
  };

  const handleCustomJsonlLine = (line: string): boolean => {
    const lifecycle = cliOutputLifecycle.parseCliBackendLifecycleLine({
      line,
      backendId: params.providerId,
      backend: params.backend,
      parse: params.parseJsonlLifecycleEvent,
    });
    if (lifecycle) {
      if ("errorText" in lifecycle) {
        parseErrorText = lifecycle.errorText;
      } else {
        for (const parsed of decodeCliRecords(line)) {
          observeSessionId(parsed);
        }
        for (const event of lifecycle.events) {
          params.onCompaction?.(cliOutputLifecycle.projectCliBackendLifecycleEvent(event));
        }
      }
      return true;
    }
    if (!params.parseJsonlEvent) {
      return false;
    }
    let parsed: ReturnType<CliBackendParseJsonlEvent>;
    try {
      parsed = params.parseJsonlEvent(line, {
        backendId: params.providerId,
        backend: params.backend,
      });
    } catch (error) {
      parseErrorText = truncateUtf16Safe(
        `CLI backend ${params.providerId} JSONL parser failed: ${formatErrorMessage(error)}`,
        500,
      );
      return true;
    }
    if (parsed == null) {
      return false;
    }
    for (const event of Array.isArray(parsed) ? parsed : [parsed]) {
      if (event.kind === "result") {
        sawTerminalResult = true;
      }
      handleCustomJsonlEvent(event);
    }
    return true;
  };

  // Committed or rejected text cannot join the next reply through a tool split.
  const resetReplySegment = () => {
    segmentStart = assistantText.length;
    currentMessageStart = segmentStart;
    preserveFrom = segmentStart;
    pendingMessageSeparator = false;
    sawToolUseSinceText = false;
    currentMessageHadToolUse = false;
    previousMessageHadToolUse = false;
  };

  const handleParsedRecord = (parsed: Record<string, unknown>) => {
    if (parseErrorText) {
      return;
    }
    const attributedParentToolUseId = readClaudeAttributedSubagentProgressId(parsed);
    if (attributedParentToolUseId) {
      params.onAttributedSubagentProgress?.(attributedParentToolUseId);
    }
    if (
      claudeStreamJson &&
      parsed.type === "system" &&
      parsed.subtype === "init" &&
      !isClaudeSubagentRecord(parsed)
    ) {
      try {
        params.onNativeTools?.(parsed.tools);
      } catch (error) {
        parseErrorText = truncateUtf16Safe(formatErrorMessage(error), 500);
        return;
      }
    }
    if (
      parsed.type === "result" &&
      parsed.openclaw_interim_result !== true &&
      supportsCliJsonlToolEvents(params)
    ) {
      sawTerminalResult = true;
    }
    observeSessionId(parsed);
    const nextUsage = readCliUsage(parsed);
    const isClaudeTerminalResult = claudeStreamJson && parsed.type === "result";
    if (isClaudeTerminalResult && nextUsage && usage) {
      diagnosticUsage = nextUsage;
    }
    if (nextUsage) {
      params.onUsage?.(nextUsage, isClaudeTerminalResult);
    }
    const shouldUseUsage =
      !supportsCliJsonlToolEvents(params) || parsed.type !== "result" || !usage;
    if (shouldUseUsage) {
      usage = nextUsage ?? usage;
    }
    if (
      parsed.type === "assistant" &&
      isRecord(parsed.message) &&
      !isClaudeSubagentRecord(parsed)
    ) {
      if (claudeStreamJson) {
        const messageId = typeof parsed.message.id === "string" ? parsed.message.id : undefined;
        if (messageId && messageId !== currentClaudeMessageId) {
          // A stream delta can precede the first identified snapshot for the same message.
          if (currentClaudeMessageId === undefined) {
            currentClaudeMessageId = messageId;
          } else {
            beginClaudeMessage(messageId);
          }
        }
      }
      resumeCheckpointId = pickCliResumeCheckpointId({ ...params, parsed }) ?? resumeCheckpointId;
      params.onAssistantMessage?.(parsed.message);
      if (claudeStreamJson && isClaudeSyntheticNoResponse(parsed)) {
        sawClaudeSyntheticNoResponse = true;
      }
    }
    const geminiErrorText = isGeminiStreamJsonDialect(params)
      ? readGeminiCliStreamJsonError(parsed)
      : undefined;
    if (
      isGeminiStreamJsonDialect(params) &&
      (parsed.type === "tool_use" || parsed.type === "tool_result" || parsed.type === "result")
    ) {
      sawGeminiStructuredOutput = true;
      // A Gemini tool call ends the message before it, like a tool_use block.
      sawToolUseSinceText ||= parsed.type === "tool_use";
    }
    if (geminiErrorText) {
      output = {
        text: "",
        sessionId,
        usage,
        errorText: preferGeminiCliStreamJsonError(output?.errorText, geminiErrorText),
      };
      return;
    }

    const stopHookFeedback =
      claudeStreamJson && !isClaudeSubagentRecord(parsed) && isClaudeStopHookFeedbackRecord(parsed);
    let endedTaggedReasoningText = "";
    if (parsed.type === "result" || stopHookFeedback) {
      endedTaggedReasoningText = endClaudeMessage();
      if (classifyClaudeCommentary) {
        flushPendingClaudeText("assistant");
      }
    }

    if (stopHookFeedback) {
      resetReplySegment();
    }

    let result = parseClaudeCliJsonlResult({
      backend: params.backend,
      providerId: params.providerId,
      parsed,
      sessionId,
      usage,
    });
    if (result) {
      // A stopped turn is only a failure when nothing was delivered; text
      // streamed before the stop is still the reply, so this one defers until
      // the resolved text below is known.
      const stoppedTurn =
        result.terminalFailure?.reason === "turn_stopped" ? result.terminalFailure : undefined;
      const stoppedTurnErrorText = stoppedTurn ? (result.errorText ?? "") : "";
      if (stoppedTurn) {
        const delivered = { ...result };
        delete delivered.errorText;
        delete delivered.terminalFailure;
        result = delivered;
      } else if (result.errorText) {
        output = result;
        return;
      }
      if (result.text) {
        ledger.retain(result.text.length);
      }
      if (claudeStreamJson && result.text) {
        const taggedResult = partitionLeadingTaggedReasoning(result.text, true);
        if (!taggedResult.pending && taggedResult.reasoningText) {
          if (
            !thinkingTracker.emittedText &&
            taggedResult.reasoningText !== currentTaggedReasoningText &&
            taggedResult.reasoningText !== endedTaggedReasoningText
          ) {
            setTaggedReasoningText(
              projectCliTaggedReasoning({
                deltas: [{ kind: "thinking", text: taggedResult.reasoningText }],
                currentText: "",
                hasNativeThinking: false,
                onThinkingDelta: params.onThinkingDelta,
                onVisibleText: emitClaudeVisibleText,
              }),
            );
          }
          result = { ...result, text: taggedResult.visibleText.trim() };
        }
      }
      // Empty terminal result can follow already-streamed text; keep that text.
      const streamedText = assistantText.slice(segmentStart).trim();
      const preservedCandidate = assistantText.slice(preserveFrom).trim();
      const keepStreamed = preferStreamedClaudeTextOverResult({
        streamedText: preservedCandidate,
        finalMessageText: assistantText.slice(currentMessageStart).trim(),
        resultText: result.text,
      });
      const nextText = (
        keepStreamed ? preservedCandidate : result.text || streamedText || texts.join("\n").trim()
      ).trim();
      const { text, textParts, completedText } = appendCliResultText(output, nextText);
      const syntheticNoResponse =
        sawClaudeSyntheticNoResponse &&
        parsed.subtype === "success" &&
        !text &&
        toolTracker.pendingByIndex.size === 0 &&
        toolTracker.startedIds.size === 0 &&
        toolTracker.resultDeliveredIds.size === 0;
      output = {
        ...result,
        text,
        ...((textParts.length > 1 ||
          output?.textParts ||
          parsed.openclaw_interim_result === true) &&
        !(stoppedTurn && !nextText)
          ? { textParts }
          : {}),
        ...(syntheticNoResponse
          ? {
              errorText: CLAUDE_SYNTHETIC_NO_RESPONSE_ERROR,
              terminalFailure: { reason: "synthetic_no_response" as const },
            }
          : {}),
        // The CLI's own terminal reason outranks the synthetic marker: it names
        // why the turn stopped and must not be retried like a format fault.
        // Delivery is judged on this result's own segment; text an earlier
        // interim result already committed is not this turn's reply.
        ...(stoppedTurn && !nextText
          ? { text: "", errorText: stoppedTurnErrorText, terminalFailure: stoppedTurn }
          : {}),
        ...(resumeCheckpointId ? { resumeCheckpointId } : {}),
        ...(diagnosticUsage ? { diagnosticUsage } : {}),
      };
      // The result envelope carries the final message when present.
      output = withCliRawFinalText(output, result.text?.trim() || finalStreamedMessageText());
      if (
        parsed.openclaw_interim_result === true &&
        completedText &&
        !output.errorText &&
        !output.terminalFailure
      ) {
        params.onCompletedReply?.(completedText, textParts.length - 1);
      }
      // An interim result commits its segment. Rebase boundary state so later
      // text is judged on its own, while delta snapshots stay cumulative.
      resetReplySegment();
      return;
    }

    const recordedItemTexts = texts.length;
    finalItemText = recordItemText(parsed, texts, finalItemText);
    if (texts.length > recordedItemTexts) {
      ledger.retain(texts[texts.length - 1]?.length ?? 0);
    }

    if (parsed.type === "stream_event" && isRecord(parsed.event)) {
      const evt = parsed.event;
      // Tool-split turns stream as separate assistant messages. Mark the
      // boundary so accumulated text joins with a paragraph break instead of
      // gluing the pre-tool text to the next message's first delta.
      // Subagent messages interleave with the parent's and never bound its reply.
      const parentRecord = !isClaudeSubagentRecord(parsed);
      if (parentRecord && evt.type === "message_start") {
        const message = isRecord(evt.message) ? evt.message : undefined;
        beginClaudeMessage(typeof message?.id === "string" ? message.id : undefined);
      } else if (parentRecord && evt.type === "message_stop") {
        finishTaggedReasoningMessage();
      }
      const isToolUseBlockStart =
        evt.type === "content_block_start" &&
        isRecord(evt.content_block) &&
        isClaudeToolUseBlockType(evt.content_block.type);
      if (isToolUseBlockStart) {
        sawToolUseSinceText = true;
        finalItemText = undefined;
        currentMessageHadToolUse = true;
      }
      if (classifyClaudeCommentary) {
        if (isToolUseBlockStart) {
          flushPendingClaudeText("commentary");
        } else if (evt.type === "content_block_start" || evt.type === "message_stop") {
          flushPendingClaudeText("assistant");
        }
      }
    }

    if (params.onThinkingDelta || params.onThinkingProgress) {
      dispatchClaudeCliThinking({
        backend: params.backend,
        providerId: params.providerId,
        parsed,
        tracker: thinkingTracker,
        onThinkingDelta: params.onThinkingDelta,
        onThinkingProgress: params.onThinkingProgress,
      });
    }

    const delta = parseClaudeCliStreamingDelta({
      backend: params.backend,
      providerId: params.providerId,
      parsed,
      previousText: currentClaudeMessageText,
    });
    if (delta) {
      // Charged per copy: the message holds this delta as its snapshot diff
      // base until it ends, the router charges what it still holds back, and
      // the reply text is charged for the turn where it is appended.
      messageRetained.retain(delta.length);
      currentClaudeMessageText = `${currentClaudeMessageText}${delta}`;
      if (claudeStreamJson) {
        routeTaggedReasoningDeltas(taggedReasoningRouter.push(delta));
      } else {
        emitClaudeVisibleText(delta);
      }
    }

    if (params.onToolUseStart || params.onToolResult) {
      dispatchGeminiCliStreamingToolEvent({
        backend: params.backend,
        providerId: params.providerId,
        parsed,
        tracker: toolTracker,
        onToolUseStart: params.onToolUseStart,
        onToolResult: params.onToolResult,
      });
    }
    if (
      claudeStreamJson ||
      params.onToolUseStart ||
      params.onToolInputDelta ||
      params.onToolResult
    ) {
      const onToolUseStart =
        claudeStreamJson && parsed.type === "assistant"
          ? (tool: Parameters<NonNullable<typeof params.onToolUseStart>>[0]) => {
              sawToolUseSinceText = true;
              finalItemText = undefined;
              currentMessageHadToolUse = true;
              if (classifyClaudeCommentary) {
                flushPendingClaudeText("commentary");
              }
              params.onToolUseStart?.(tool);
            }
          : params.onToolUseStart;
      dispatchClaudeCliStreamingToolEvent({
        backend: params.backend,
        providerId: params.providerId,
        parsed,
        tracker: toolTracker,
        onToolUseStart,
        onToolInputDelta: params.onToolInputDelta,
        onToolResult: params.onToolResult,
      });
    }
    if (!delta && isGeminiStreamJsonDialect(params)) {
      if (
        parsed.type === "message" &&
        parsed.role === "assistant" &&
        typeof parsed.content === "string" &&
        parsed.content
      ) {
        // Tool output before this text starts a new final-message segment so
        // pre-tool narration is never the final message.
        if (sawToolUseSinceText) {
          currentMessageStart = assistantText.length;
          sawToolUseSinceText = false;
        }
        appendAssistantText(parsed.content);
      } else if (parsed.type === "result" && parsed.status === "success") {
        output = withCliRawFinalText(
          {
            text: assistantText.trim(),
            sessionId,
            usage,
          },
          finalStreamedMessageText(),
        );
      }
    }
  };

  const handleJsonlLine = (rawLine: string) => {
    if (parseErrorText) {
      return;
    }
    const line = rawLine.trim();
    if (!line && !claudeStreamJson) {
      return;
    }
    rawLines += 1;
    if (!line) {
      return;
    }
    if (handleCustomJsonlLine(line)) {
      return;
    }
    for (const parsed of decodeCliRecords(line)) {
      if (claudeStreamJson) {
        normalizeClaudeCliStreamJsonRecord(parsed);
      }
      handleParsedRecord(parsed);
    }
  };

  return {
    push(chunk: string) {
      if (!chunk || parseErrorText) {
        return;
      }
      if (
        !frameBoundedCliJsonlChunk(lineBuffer, chunk, outputLimits.maxPendingLineChars, (line) => {
          handleJsonlLine(line);
          return !parseErrorText;
        })
      ) {
        parseErrorText = streamJsonOutputLimitErrorText("line", outputLimits.maxPendingLineChars);
      }
    },
    finish() {
      try {
        if (parseErrorText) {
          return;
        }
        const tail = lineBuffer.pending;
        lineBuffer.pending = "";
        if (tail) {
          handleJsonlLine(tail);
        }
        finishTaggedReasoningMessage();
        if (classifyClaudeCommentary) {
          flushPendingClaudeText("assistant");
        }
      } finally {
        toolTracker.inputProgressById.clear();
      }
    },
    getErrorText() {
      return parseErrorText || null;
    },
    hasTerminalResult() {
      return sawTerminalResult;
    },
    getOutput(): (CliOutput & { partialOutputRejected?: true }) | null {
      if (parseErrorText) {
        return {
          text: "",
          sessionId,
          usage,
          ...(diagnosticUsage ? { diagnosticUsage } : {}),
          errorText: parseErrorText,
        };
      }
      if (output) {
        return output;
      }
      return resolveCliStreamOutput({
        params,
        texts,
        assistantText,
        sessionId,
        usage,
        resumeCheckpointId,
        rawLines,
        sawCustomJsonlEvent,
        sawGeminiStructuredOutput,
        claudeStreamJson,
        finalStreamedMessageText,
      });
    },
  };
}
