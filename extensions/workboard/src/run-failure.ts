import type { WorkboardCard } from "@openclaw/workboard-contract";
import { parseProviderUsageLimit } from "openclaw/plugin-sdk/provider-usage-limit";
import { formatUsageLimitReset, nodeTicketStartRequestPatch } from "./node-ticket-start-queue.js";
import { appendComment } from "./store-card-helpers.js";
import { isWorkboardNodeTicket } from "./store-constants.js";
import type { WorkboardOwnedCardPatch } from "./store-inputs.js";

// Retry this long after a usage limit whose message names no reset time.
const USAGE_LIMIT_RETRY_MS = 30 * 60 * 1000;

/** Why a run failed, from the error its agent_end reported. */
type RunFailure =
  | { kind: "usage_limit"; resetsAt: number; message: string }
  | { kind: "error"; message: string };

function classifyRunFailure(message: string, now: number): RunFailure {
  const limit = parseProviderUsageLimit(message, now);
  return limit
    ? { kind: "usage_limit", resetsAt: limit.resetsAt ?? now + USAGE_LIMIT_RETRY_MS, message }
    : { kind: "error", message };
}

/**
 * What a card blocked by its run's failure still needs once that run's error
 * is on its attempt. The lifecycle block and the agent_end that carries the
 * error arrive in either order, so both writes ask; a comment written with or
 * after the block means a reason already explains it. A node ticket whose
 * login hit a usage limit goes back to todo, queued until the reset; any
 * other failure leaves its error as the block's comment.
 */
export function runFailurePatch(
  card: WorkboardCard,
  now: number,
): WorkboardOwnedCardPatch | undefined {
  const attempt = card.metadata?.attempts?.at(-1);
  const endedAt = attempt?.endedAt;
  if (
    card.status !== "blocked" ||
    attempt?.status !== "blocked" ||
    !attempt.error ||
    endedAt === undefined ||
    card.metadata?.comments?.some((comment) => comment.createdAt >= endedAt)
  ) {
    return undefined;
  }
  const failure = classifyRunFailure(attempt.error, now);
  const nodeId = card.metadata?.automation?.target?.nodeId;
  const requeue =
    failure.kind === "usage_limit" && nodeId && isWorkboardNodeTicket(card)
      ? nodeTicketStartRequestPatch(
          { ...card, status: "todo", metadata: { ...card.metadata, claim: undefined } },
          { requestedAt: now, usageLimitResetsAt: failure.resetsAt },
          () =>
            `The Claude login on node ${nodeId} hit its usage limit (${failure.message}). This ticket is queued again and starts after the reset at ${formatUsageLimitReset(failure.resetsAt)}; until then nothing else starts on that node.`,
          now,
        )
      : undefined;
  return (
    requeue ?? {
      metadata: {
        ...card.metadata,
        comments: appendComment(card.metadata?.comments, `The run failed: ${failure.message}`, now),
      },
    }
  );
}
