import type { WorkboardCard, WorkboardMergeRegression } from "@openclaw/workboard-contract";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  GITHUB_PULL_URL_PATTERN,
  githubApi,
  githubRepo,
  type WorkboardGitHubAccess,
} from "./node-ticket-publish.js";
import { nodeTicketTarget } from "./node-ticket.js";
import { cardBoardId } from "./store-card-helpers.js";
import { workboardTaskClass } from "./store-constants.js";
import type { WorkboardStore } from "./store.js";

/** How long after its merge a card's PR is watched for a regression (D37). */
export const REGRESSION_WATCH_MS = 7 * 24 * 60 * 60_000;
const COMMITS_PER_PAGE = 100;
// Bounds one read of a busy base branch; a merge beyond it is read on the next sync.
const MAX_PAGES_PER_REPO = 5;

type WatchedMerge = {
  card: WorkboardCard;
  hostRepoPath: string;
  url: string;
  repo: string;
  number: number;
  mergedAt: number;
  mergeCommit: string;
};

/** A card's merged PR within its watch, with no regression recorded yet. */
function watchedMerge(card: WorkboardCard, now: number): WatchedMerge | undefined {
  const target = nodeTicketTarget(card);
  const handoff = target?.worktree?.handoff;
  const pullRequest = handoff?.phase === "published" ? handoff.pullRequest : undefined;
  if (
    !target ||
    handoff?.phase !== "published" ||
    pullRequest?.state !== "merged" ||
    pullRequest.mergedAt === undefined ||
    !pullRequest.mergeCommit ||
    pullRequest.regression ||
    now - pullRequest.mergedAt >= REGRESSION_WATCH_MS
  ) {
    return undefined;
  }
  const match = GITHUB_PULL_URL_PATTERN.exec(handoff.pullRequestUrl);
  return match?.[1] && match[2]
    ? {
        card,
        hostRepoPath: target.hostRepoPath,
        url: handoff.pullRequestUrl,
        repo: match[1].toLowerCase(),
        number: Number(match[2]),
        mergedAt: pullRequest.mergedAt,
        mergeCommit: pullRequest.mergeCommit,
      }
    : undefined;
}

/** A commit on the base branch with its own and its first parent's combined check state. */
export type BaseBranchCommit = {
  oid: string;
  message: string;
  checks?: string;
  parentChecks?: string;
};

const BASE_HISTORY_QUERY = `query($owner: String!, $name: String!, $since: GitTimestamp!, $after: String) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef {
      target {
        ... on Commit {
          history(first: ${COMMITS_PER_PAGE}, since: $since, after: $after) {
            nodes {
              oid
              message
              statusCheckRollup { state }
              parents(first: 1) { nodes { statusCheckRollup { state } } }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    }
  }
}`;

function rollupState(value: unknown): string | undefined {
  return isRecord(value) && typeof value.state === "string" ? value.state : undefined;
}

function baseBranchCommit(node: unknown): BaseBranchCommit | undefined {
  if (!isRecord(node) || typeof node.oid !== "string" || typeof node.message !== "string") {
    return undefined;
  }
  const parents =
    isRecord(node.parents) && Array.isArray(node.parents.nodes) ? node.parents.nodes : [];
  const checks = rollupState(node.statusCheckRollup);
  const parentChecks = isRecord(parents[0]) ? rollupState(parents[0].statusCheckRollup) : undefined;
  return {
    oid: node.oid,
    message: node.message,
    ...(checks ? { checks } : {}),
    ...(parentChecks ? { parentChecks } : {}),
  };
}

/** The repository's default branch commits since `since`, newest first; GraphQL errors arrive with a 200. */
async function baseBranchHistory(
  github: WorkboardGitHubAccess,
  token: string,
  repo: string,
  since: number,
): Promise<BaseBranchCommit[]> {
  const [owner, name] = repo.split("/");
  const commits: BaseBranchCommit[] = [];
  let after: string | null = null;
  for (let page = 1; page <= MAX_PAGES_PER_REPO; page += 1) {
    const reply = await githubApi(github, token, "POST", "/graphql", {
      query: BASE_HISTORY_QUERY,
      variables: { owner, name, since: new Date(since).toISOString(), after },
    });
    const errors = isRecord(reply) && Array.isArray(reply.errors) ? reply.errors : [];
    if (errors.length > 0) {
      throw new Error(`GitHub GraphQL: ${JSON.stringify(errors[0]).slice(0, 300)}`);
    }
    const repository = isRecord(reply) && isRecord(reply.data) ? reply.data.repository : undefined;
    const branch = isRecord(repository) ? repository.defaultBranchRef : undefined;
    const target = isRecord(branch) ? branch.target : undefined;
    const history = isRecord(target) ? target.history : undefined;
    const nodes = isRecord(history) && Array.isArray(history.nodes) ? history.nodes : [];
    commits.push(...nodes.flatMap((node) => baseBranchCommit(node) ?? []));
    const pageInfo = isRecord(history) ? history.pageInfo : undefined;
    if (
      !isRecord(pageInfo) ||
      pageInfo.hasNextPage !== true ||
      typeof pageInfo.endCursor !== "string"
    ) {
      break;
    }
    after = pageInfo.endCursor;
  }
  return commits;
}

/**
 * Whether the base branch shows the merge regressed: a later commit reverts it
 * (git's `This reverts commit <merge>` line, or a title `Revert "… (#<number>)"`
 * as GitHub's revert button writes for a squash merge), or the merge commit's
 * own checks failed where its parent's passed. A merge commit still pending,
 * or with a red parent, is no regression of its own. At rung b a batch
 * merged by hand can turn red mid-batch and green at its last commit; that
 * counts too, and the operator dismisses it.
 */
export function mergeRegression(
  merge: Pick<WatchedMerge, "mergeCommit" | "number">,
  commits: readonly BaseBranchCommit[],
): Pick<WorkboardMergeRegression, "kind" | "commit"> | undefined {
  const revertTitle = new RegExp(`^Revert ".*\\(#${merge.number}\\)"`);
  const revert = commits.find(
    (commit) =>
      commit.oid !== merge.mergeCommit &&
      (commit.message.includes(`This reverts commit ${merge.mergeCommit}`) ||
        revertTitle.test(commit.message)),
  );
  if (revert) {
    return { kind: "revert", commit: revert.oid };
  }
  const own = commits.find((commit) => commit.oid === merge.mergeCommit);
  return own &&
    (own.checks === "FAILURE" || own.checks === "ERROR") &&
    own.parentChecks === "SUCCESS"
    ? { kind: "red_main", commit: own.oid }
    : undefined;
}

function regressionNotice(
  found: Pick<WorkboardMergeRegression, "kind" | "commit">,
  demotedClass: string | undefined,
): string {
  const what =
    found.kind === "revert"
      ? `commit ${found.commit.slice(0, 7)} on the base branch reverts this PR's merge.`
      : `this PR's merge commit ${found.commit.slice(0, 7)} failed its checks on the base branch, where the commit before it passed.`;
  return [
    `**Regression:** ${what}`,
    ...(demotedClass
      ? [
          "",
          `Class ${demotedClass} moved from rung c to b (D37). The operator promotes it again with workboard.boards.upsert.`,
        ]
      : []),
    "",
    "If this is not a regression, the operator dismisses it with workboard.cards.dismissRegression; the trust KPIs then leave it out.",
  ].join("\n");
}

/**
 * Watches every card's merged PR for 7 days after its merge (D37): one
 * paged read of each repository's default branch since its oldest watched
 * merge. A regression is recorded on the card with a notice, and a merge an
 * agent accepted at rung c moves its class back to b first, so a crash
 * between the two leaves the class demoted. A merge the PR state sync saw
 * before it recorded merge facts is not watched. A failure leaves every
 * merge watched and warns.
 */
export async function watchMergeRegressions(params: {
  store: WorkboardStore;
  github: WorkboardGitHubAccess;
  cards: readonly WorkboardCard[];
  now: () => number;
  warn: (message: string) => void;
}): Promise<void> {
  const watched = params.cards.flatMap((card) => watchedMerge(card, params.now()) ?? []);
  const byRepo = new Map<string, { token: string; merges: WatchedMerge[] }>();
  const hosts = new Map<string, Promise<{ repo: string; token: string }>>();
  for (const merge of watched) {
    const host = hosts.get(merge.hostRepoPath) ?? githubRepo(params.github, merge.hostRepoPath);
    hosts.set(merge.hostRepoPath, host);
    try {
      const { repo, token } = await host;
      // A re-pointed origin must not judge another repo's history.
      if (merge.repo !== repo.toLowerCase()) {
        continue;
      }
      const entry = byRepo.get(repo) ?? { token, merges: [] };
      entry.merges.push(merge);
      byRepo.set(repo, entry);
    } catch (error) {
      params.warn(
        `workboard regression watch skipped ${merge.card.id}: ${formatErrorMessage(error)}`,
      );
    }
  }
  for (const [repo, { token, merges }] of byRepo) {
    let commits: BaseBranchCommit[];
    try {
      const since = Math.min(...merges.map((merge) => merge.mergedAt));
      commits = await baseBranchHistory(params.github, token, repo, since);
    } catch (error) {
      params.warn(`workboard regression watch failed for ${repo}: ${formatErrorMessage(error)}`);
      continue;
    }
    for (const merge of merges) {
      const found = mergeRegression(merge, commits);
      if (!found) {
        continue;
      }
      const { card } = merge;
      const merged = nodeTicketTarget(card)?.worktree?.reviews?.at(-1);
      const taskClass = workboardTaskClass(card.labels);
      const demoted =
        merged?.decidedBy === "agent" &&
        merged.rung === "c" &&
        taskClass !== undefined &&
        (await params.store.demoteClassFromRungC(cardBoardId(card), taskClass));
      await params.store.recordMergeRegression(card.id, {
        pullRequestUrl: merge.url,
        regression: { ...found, at: params.now(), ...(demoted ? { demoted: true } : {}) },
        notice: regressionNotice(found, demoted ? taskClass : undefined),
      });
    }
  }
}
