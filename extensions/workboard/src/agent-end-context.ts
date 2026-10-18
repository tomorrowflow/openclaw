import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

/**
 * The context the run's last model call carried (draft D16: context use at
 * turn end). agent_end messages include the session's earlier runs, so only
 * the last assistant message after the final user prompt counts; a run that
 * failed before replying has none. A harness that sums usage over the turn's
 * calls (Codex) reports the last call as `contextUsage.promptTokens`;
 * otherwise input plus cache read plus cache write is that call's prompt.
 */
export function turnEndContextTokens(messages: readonly unknown[]): number | undefined {
  const lastPrompt = messages.findLastIndex(
    (message) => isRecord(message) && message.role === "user",
  );
  const reply = messages
    .slice(lastPrompt + 1)
    .findLast((message) => isRecord(message) && message.role === "assistant");
  const usage = isRecord(reply) ? reply.usage : undefined;
  if (!isRecord(usage)) {
    return undefined;
  }
  const context = usage.contextUsage;
  const tokens =
    isRecord(context) && context.state === "available"
      ? tokenCount(context.promptTokens)
      : tokenCount(usage.input) + tokenCount(usage.cacheRead) + tokenCount(usage.cacheWrite);
  return tokens > 0 ? Math.round(tokens) : undefined;
}

function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}
