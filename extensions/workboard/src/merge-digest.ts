import type {
  WorkboardCard,
  WorkboardMergeDigestEntry,
  WorkboardMergeDigestResult,
} from "@openclaw/workboard-contract";
import { GITHUB_PULL_URL_PATTERN } from "./node-ticket-publish.js";
import { nodeTicketTarget } from "./node-ticket.js";
import { workboardTaskClass } from "./store-constants.js";

/** How far back a digest reaches when the caller names no start: one daily packet. */
export const MERGE_DIGEST_DEFAULT_WINDOW_MS = 24 * 60 * 60_000;

/** A card's merge in the window when an agent accepted its merged (last) round at rung c. */
function digestEntry(
  card: WorkboardCard,
  since: number,
): (WorkboardMergeDigestEntry & { taskClass: string }) | undefined {
  const worktree = nodeTicketTarget(card)?.worktree;
  const handoff = worktree?.handoff;
  if (card.metadata?.automation?.probe || handoff?.phase !== "published") {
    return undefined;
  }
  const { pullRequest } = handoff;
  const merged = worktree?.reviews?.at(-1);
  const repo = GITHUB_PULL_URL_PATTERN.exec(handoff.pullRequestUrl)?.[1];
  if (
    !repo ||
    pullRequest?.state !== "merged" ||
    pullRequest.mergedAt === undefined ||
    pullRequest.mergedAt < since ||
    !pullRequest.mergeCommit ||
    merged?.decidedBy !== "agent" ||
    merged.verdict !== "accept" ||
    merged.rung !== "c"
  ) {
    return undefined;
  }
  return {
    taskClass: workboardTaskClass(card.labels) ?? "unclassified",
    cardId: card.id,
    title: card.title,
    repo,
    pullRequestUrl: handoff.pullRequestUrl,
    mergedAt: pullRequest.mergedAt,
    mergeCommit: pullRequest.mergeCommit,
    autoMerged: pullRequest.autoMerged === true,
    ...(merged.sampled ? { sampled: true as const } : {}),
    ...(merged.readAt === undefined ? {} : { readAt: merged.readAt }),
    ...(pullRequest.regression ? { regression: pullRequest.regression } : {}),
    // The queue merges with merge commits; a squash merged by hand reverts
    // without `-m 1`, and git names the flag when it refuses.
    revertCommand: `git revert -m 1 ${pullRequest.mergeCommit}`,
  };
}

function minuteUtc(at: number): string {
  return `${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function entryLine(entry: WorkboardMergeDigestEntry): string {
  const number = entry.pullRequestUrl.split("/").at(-1);
  const how = entry.autoMerged ? "auto-merged" : "merged by hand";
  const notes = [
    ...(entry.sampled ? [entry.readAt === undefined ? "sampled, unread" : "sampled, read"] : []),
    ...(entry.regression && entry.regression.dismissedAt === undefined
      ? [
          entry.regression.kind === "revert"
            ? `regressed: reverted by ${entry.regression.commit.slice(0, 7)}`
            : "regressed: its merge commit went red",
        ]
      : []),
  ];
  return [
    `- [#${number}](${entry.pullRequestUrl}) ${entry.title}: ${how} ${minuteUtc(entry.mergedAt)} as ${entry.mergeCommit.slice(0, 7)}${notes.length > 0 ? ` (${notes.join("; ")})` : ""}`,
    `  Revert in ${entry.repo}: \`${entry.revertCommand}\``,
  ].join("\n");
}

/**
 * The merge digest (D37): every PR merged since `since` whose last round an
 * agent accepted at rung c, per task class, oldest merge first, with the
 * command that reverts it. A merge carries the last published round, so a
 * ticket counts by that round's rung, wherever its class stands now.
 */
export function projectWorkboardMergeDigest(
  cards: readonly WorkboardCard[],
  boardId: string,
  since: number,
  now: number,
): WorkboardMergeDigestResult {
  const byClass = new Map<string, WorkboardMergeDigestEntry[]>();
  for (const card of cards) {
    const found = digestEntry(card, since);
    if (found) {
      const { taskClass, ...entry } = found;
      byClass.set(taskClass, [...(byClass.get(taskClass) ?? []), entry]);
    }
  }
  const classes = [...byClass]
    .map(([taskClass, merges]) => ({
      taskClass,
      merges: merges.toSorted((a, b) => a.mergedAt - b.mergedAt),
    }))
    .toSorted((a, b) => a.taskClass.localeCompare(b.taskClass));
  const count = classes.reduce((sum, entry) => sum + entry.merges.length, 0);
  const text =
    count === 0
      ? `Nothing merged at rung c since ${minuteUtc(since)}.`
      : [
          `**Merged at rung c** since ${minuteUtc(since)}: ${count} PR${count === 1 ? "" : "s"}`,
          ...classes.flatMap(({ taskClass, merges }) => [
            "",
            `**${taskClass}**`,
            ...merges.map(entryLine),
          ]),
        ].join("\n");
  return { boardId, since, generatedAt: now, classes, text };
}
