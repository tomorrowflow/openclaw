import type { WorkboardCard, WorkboardComment } from "@openclaw/workboard-contract";
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

/** The operator's messages the agent has not answered yet: those after its last comment. */
export function unansweredOperatorComments(
  card: WorkboardCard,
  agentId: string,
): WorkboardComment[] {
  const comments = card.metadata?.comments ?? [];
  const lastAnswer = comments.findLastIndex((comment) => comment.source === `agent:${agentId}`);
  return comments.slice(lastAnswer + 1).filter((comment) => comment.source === "operator");
}

/** The turn message: the card's state, the unanswered messages, and the rules of the thread. */
export function buildFeedAnswerMessage(params: {
  card: WorkboardCard;
  boardId: string;
  agentId: string;
}): string {
  const { card } = params;
  const comments = card.metadata?.comments ?? [];
  const verdict = comments.findLast((comment) => reviewVerdictOf(comment) !== undefined);
  const unanswered = unansweredOperatorComments(card, params.agentId);
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
    `- Answer with exactly one workboard_comment on card ${card.id}. That comment is what the operator sees in the thread, so keep it short and plain. Nothing else you write reaches the operator.`,
    "- Act on a clear instruction with your Workboard tools: comment, rework (move to todo with the operator's reason in your comment), hold or block, unblock, priority, labels. Ask back only when the instruction is unclear.",
    "- Move the card to done only when the last review verdict is accept, or when the operator explicitly says to ship it anyway.",
    "- You cannot start cards. Say so and point to the Control UI.",
    "- Never interrupt a running round. Record the request; the worker reads card comments in its next round.",
    "- This conversation is recorded on the card. Do not edit MEMORY.md for it.",
  ].join("\n");
}
