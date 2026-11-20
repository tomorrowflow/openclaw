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

/**
 * Sheds a round's decisions, then its review items, then its changed-file list.
 * Its commit range and totals stay: the Screenshots and Prototype tabs and the
 * verifier read the round's files from git through that range.
 */
function degradedNodeRound(round: WorkboardNodeRound): WorkboardNodeRound | undefined {
  if (round.decisions) {
    const { decisions: _decisions, ...rest } = round;
    return rest;
  }
  if (round.review?.items) {
    const { items: _items, ...review } = round.review;
    return { ...round, review };
  }
  if (round.changes?.files.length) {
    return { ...round, changes: { ...round.changes, files: [] } };
  }
  return undefined;
}

/**
 * A node ticket's round facts shrink before anything else, oldest round first;
 * they only inform. A round degrades to its commit range and is never dropped
 * here; MAX_NODE_ROUNDS bounds how many there are.
 */
function withOldestNodeRoundTrimmed(metadata: WorkboardMetadata): WorkboardMetadata | undefined {
  const target = metadata.automation?.target;
  const rounds = target?.worktree?.rounds ?? [];
  for (const [index, round] of rounds.entries()) {
    const degraded = degradedNodeRound(round);
    if (target?.worktree && degraded) {
      const worktree = { ...target.worktree, rounds: rounds.with(index, degraded) };
      return {
        ...metadata,
        automation: { ...metadata.automation, target: { ...target, worktree } },
      };
    }
  }
  return undefined;
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
