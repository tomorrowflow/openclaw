import type { WorkboardCard, WorkboardComment } from "@openclaw/workboard-contract";
import { asRecord, readStringValue } from "openclaw/plugin-sdk/string-coerce-runtime";
import { reviewVerdictOf } from "./review-readiness.js";

/** A thread answer that runs longer than this is reported as failed. */
export const FEED_ANSWER_TIMEOUT_MS = 5 * 60_000;
const RECENT_COMMENTS = 5;
const COMMENT_CHARS = 600;

/** One session per card, so the agent remembers the thread's earlier exchange. */
export function feedAnswerSessionKey(agentId: string, cardId: string): string {
  return `agent:${agentId}:workboard-thread:${cardId}`;
}

function trimmed(text: string): string {
  const flat = text.trim();
  return flat.length > COMMENT_CHARS ? `${flat.slice(0, COMMENT_CHARS)}…` : flat;
}

function commentLine(comment: WorkboardComment): string {
  return `- ${comment.source ?? "board"}: ${trimmed(comment.body)}`;
}

/**
 * The operator's messages the agent has not answered yet: those after
 * `throughId`, the last one an earlier turn of the same run of turns included,
 * else after the agent's last comment. An answer can land after a message
 * sent while it was being written, so position alone would skip that message.
 */
export function unansweredOperatorComments(
  card: WorkboardCard,
  agentId: string,
  throughId?: string,
): WorkboardComment[] {
  const comments = card.metadata?.comments ?? [];
  const through = throughId ? comments.findIndex((comment) => comment.id === throughId) : -1;
  const from =
    through >= 0
      ? through
      : comments.findLastIndex((comment) => comment.source === `agent:${agentId}`);
  return comments.slice(from + 1).filter((comment) => comment.source === "operator");
}

/** The text of the session's last assistant message, or undefined for none or NO_REPLY. */
export function finalAssistantText(messages: readonly unknown[]): string | undefined {
  const last = messages.map(asRecord).findLast((message) => message.role === "assistant");
  const content = last?.content;
  const text = (
    Array.isArray(content)
      ? content
          .map(asRecord)
          .filter((part) => part.type === "text")
          .map((part) => readStringValue(part.text) ?? "")
          .join("")
      : (readStringValue(content) ?? "")
  ).trim();
  return text && text !== "NO_REPLY" ? text : undefined;
}

/** The turn message: the card's state, the unanswered messages, and the rules of the thread. */
export function buildFeedAnswerMessage(params: {
  card: WorkboardCard;
  boardId: string;
  unanswered: readonly WorkboardComment[];
}): string {
  const { card, unanswered } = params;
  const comments = card.metadata?.comments ?? [];
  const verdict = comments.findLast((comment) => reviewVerdictOf(comment) !== undefined);
  return [
    `The operator wrote in the chat thread of Workboard card ${card.id} on board ${params.boardId}.`,
    "",
    "## Card",
    `Title: ${card.title}`,
    `Status: ${card.status}`,
    `Labels: ${card.labels?.length ? card.labels.join(", ") : "none"}`,
    `Last review verdict: ${verdict ? trimmed(verdict.body) : "none yet"}`,
    "",
    "## Recent comments",
    ...(comments.length ? comments.slice(-RECENT_COMMENTS).map(commentLine) : ["none"]),
    "",
    "## The operator's messages to answer",
    ...unanswered.map(commentLine),
    "",
    "## How to answer",
    "- Your final reply is your answer: Workboard posts it on the card as your comment, and the thread shows it. Keep it short and plain. Do not answer with workboard_comment.",
    "- Act on a clear instruction with your Workboard tools: rework (move to todo; give the operator's reason in your answer), hold or block, unblock, priority, labels. Ask back only when the instruction is unclear.",
    "- Move the card to done only when the last review verdict is accept, or when the operator explicitly says to ship it anyway.",
    "- You cannot start cards. Say so and point to the Control UI.",
    "- Never interrupt a running round, and leave a card another agent has claimed unchanged. Say so in your answer; the worker reads card comments in its next round.",
    "- This conversation is recorded on the card. Do not edit MEMORY.md for it.",
  ].join("\n");
}
