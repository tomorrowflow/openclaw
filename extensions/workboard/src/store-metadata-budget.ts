import type {
  WorkboardAttachment,
  WorkboardLink,
  WorkboardMetadata,
  WorkboardNodeRound,
} from "@openclaw/workboard-contract";
import { definedFields } from "../record-fields.js";
import { grillLogAttachmentId } from "./node-ticket-grill.js";
import { MAX_CARD_ATTACHMENTS, MAX_CARD_METADATA_BYTES } from "./store-constants.js";

export function isDependencyLink(link: WorkboardLink): boolean {
  return link.type === "parent" || link.type === "child";
}

/** Drops the oldest attachments past the cap; the grilling log is never one of them. */
export function capAttachments(
  attachments: WorkboardAttachment[],
  keepId: string | undefined,
): WorkboardAttachment[] {
  let excess = attachments.length - MAX_CARD_ATTACHMENTS;
  return attachments.filter((entry) => {
    if (excess <= 0 || entry.id === keepId) {
      return true;
    }
    excess -= 1;
    return false;
  });
}

export function removeUndefinedMetadataFields(metadata: WorkboardMetadata): WorkboardMetadata {
  const next = definedFields({ ...metadata });
  for (const [key, value] of Object.entries(next)) {
    if ((Array.isArray(value) && value.length === 0) || (key === "failureCount" && value === 0)) {
      Reflect.deleteProperty(next, key);
    }
  }
  return next;
}

function metadataByteSize(metadata: WorkboardMetadata): number {
  return Buffer.byteLength(JSON.stringify(metadata), "utf8");
}

/** Sheds a round's decisions, then its review items; the counts and changes stay. */
function degradedNodeRound(round: WorkboardNodeRound): WorkboardNodeRound | undefined {
  if (round.decisions) {
    const { decisions: _decisions, ...rest } = round;
    return rest;
  }
  if (round.review?.items) {
    const { items: _items, ...review } = round.review;
    return { ...round, review };
  }
  return undefined;
}

/**
 * A node ticket's round facts go before anything else, oldest round first; they only inform.
 * The oldest round degrades before it goes, so its review findings outlast its decision trail.
 */
function withOldestNodeRoundTrimmed(metadata: WorkboardMetadata): WorkboardMetadata | undefined {
  const target = metadata.automation?.target;
  const [oldest, ...newer] = target?.worktree?.rounds ?? [];
  if (!target?.worktree || !oldest) {
    return undefined;
  }
  const degraded = degradedNodeRound(oldest);
  const worktree = { ...target.worktree, rounds: degraded ? [degraded, ...newer] : newer };
  return { ...metadata, automation: { ...metadata.automation, target: { ...target, worktree } } };
}

export function trimMetadataToBudget(
  metadata: WorkboardMetadata,
  options: { preserveProofId?: string; preserveNotificationId?: string } = {},
): WorkboardMetadata {
  let next = removeUndefinedMetadataFields(metadata);
  const grillLogId = grillLogAttachmentId(next);
  while (metadataByteSize(next) > MAX_CARD_METADATA_BYTES) {
    const currentSize = metadataByteSize(next);
    const withTrimmedRound = withOldestNodeRoundTrimmed(next);
    if (withTrimmedRound) {
      next = withTrimmedRound;
      continue;
    }
    for (const key of [
      "attempts",
      "diagnostics",
      "notifications",
      "proof",
      "artifacts",
      "attachments",
      "workerLogs",
      "links",
      "comments",
    ] as const) {
      const entries = next[key];
      if (!entries?.length) {
        continue;
      }
      const preserveId =
        key === "proof"
          ? options.preserveProofId
          : key === "notifications"
            ? options.preserveNotificationId
            : grillLogId;
      const index =
        key === "proof" || key === "notifications" || key === "attachments"
          ? (next[key]?.findIndex((entry) => entry.id !== preserveId) ?? -1)
          : key === "links"
            ? (next.links?.findIndex((link) => !isDependencyLink(link)) ?? -1)
            : 0;
      if (index < 0) {
        continue;
      }
      next = removeUndefinedMetadataFields({
        ...next,
        [key]: entries.filter((_, entryIndex) => entryIndex !== index),
      });
      break;
    }
    if (metadataByteSize(next) >= currentSize) {
      if (options.preserveProofId) {
        throw new Error(`card metadata cannot retain proof: ${options.preserveProofId}`);
      }
      if (options.preserveNotificationId) {
        throw new Error(
          `card metadata cannot retain notification: ${options.preserveNotificationId}`,
        );
      }
      break;
    }
  }
  return next;
}
