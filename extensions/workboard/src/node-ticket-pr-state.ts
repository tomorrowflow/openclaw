import type { WorkboardCard, WorkboardPullRequestState } from "@openclaw/workboard-contract";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  GITHUB_PULL_URL_PATTERN,
  githubApi,
  githubRepo,
  type WorkboardGitHubAccess,
} from "./node-ticket-publish.js";
import { nodeTicketTarget } from "./node-ticket.js";
import type { WorkboardStore } from "./store.js";

export const PULL_REQUEST_SYNC_INTERVAL_MS = 10 * 60_000;
const PULLS_PER_PAGE = 100;
// Bounds a backfill of old PRs; a PR beyond it keeps its last known state.
const MAX_PAGES_PER_REPO = 10;

type TrackedPullRequest = {
  card: WorkboardCard;
  worktreePath: string;
  hostRepoPath: string;
  url: string;
  repo: string;
  number: number;
};

/** A published PR whose state can still change: not yet seen merged or closed. */
function trackedPullRequest(card: WorkboardCard): TrackedPullRequest | undefined {
  const target = nodeTicketTarget(card);
  const worktree = target?.worktree;
  const handoff = worktree?.handoff;
  const state = handoff?.phase === "published" ? handoff.pullRequest?.state : undefined;
  if (
    !target ||
    !worktree ||
    handoff?.phase !== "published" ||
    card.metadata?.archivedAt ||
    state === "merged" ||
    state === "closed"
  ) {
    return undefined;
  }
  const match = GITHUB_PULL_URL_PATTERN.exec(handoff.pullRequestUrl);
  return match?.[1] && match[2]
    ? {
        card,
        worktreePath: worktree.path,
        hostRepoPath: target.hostRepoPath,
        url: handoff.pullRequestUrl,
        repo: match[1].toLowerCase(),
        number: Number(match[2]),
      }
    : undefined;
}

// Map.groupBy needs the ES2024 lib, which the extensions typecheck does not load.
function groupBy<K, T>(items: readonly T[], key: (item: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const item of items) {
    const group = groups.get(key(item));
    if (group) {
      group.push(item);
    } else {
      groups.set(key(item), [item]);
    }
  }
  return groups;
}

function pullRequestState(pull: Record<string, unknown>): WorkboardPullRequestState {
  if (typeof pull.merged_at === "string") {
    return "merged";
  }
  if (pull.state === "closed") {
    return "closed";
  }
  return pull.draft === true ? "draft" : "open";
}

/**
 * Reads the GitHub state of every published node ticket PR not yet seen
 * merged or closed, with one paged list call per repository, and records the
 * changed ones. Repositories and tokens come from the host clones' origins,
 * as for the publish. A failure leaves the last known state and warns.
 */
export async function syncPullRequestStates(params: {
  store: WorkboardStore;
  github: WorkboardGitHubAccess;
  cards: readonly WorkboardCard[];
  now: () => number;
  warn: (message: string) => void;
}): Promise<void> {
  const byHost = groupBy(
    params.cards.flatMap((card) => trackedPullRequest(card) ?? []),
    (item) => item.hostRepoPath,
  );
  const byRepo = new Map<string, { token: string; items: TrackedPullRequest[] }>();
  for (const [hostRepoPath, items] of byHost) {
    try {
      const { repo, token } = await githubRepo(params.github, hostRepoPath);
      // A re-pointed origin must not read another repo's PR with the same number.
      const matching = items.filter((item) => item.repo === repo.toLowerCase());
      const entry = byRepo.get(repo) ?? { token, items: [] };
      entry.items.push(...matching);
      byRepo.set(repo, entry);
    } catch (error) {
      params.warn(`workboard PR state sync skipped ${hostRepoPath}: ${formatErrorMessage(error)}`);
    }
  }
  for (const [repo, { token, items }] of byRepo) {
    const wanted = groupBy(items, (item) => item.number);
    const found = new Map<number, WorkboardPullRequestState>();
    try {
      for (let page = 1; page <= MAX_PAGES_PER_REPO && found.size < wanted.size; page += 1) {
        const pulls = await githubApi(
          params.github,
          token,
          "GET",
          `/repos/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=${PULLS_PER_PAGE}&page=${page}`,
        );
        const list = Array.isArray(pulls) ? pulls : [];
        for (const pull of list) {
          if (isRecord(pull) && typeof pull.number === "number" && wanted.has(pull.number)) {
            found.set(pull.number, pullRequestState(pull));
          }
        }
        if (list.length < PULLS_PER_PAGE) {
          break;
        }
      }
    } catch (error) {
      params.warn(`workboard PR state sync failed for ${repo}: ${formatErrorMessage(error)}`);
    }
    const checkedAt = params.now();
    for (const [number, state] of found) {
      for (const item of wanted.get(number) ?? []) {
        await params.store.recordPullRequestState(item.card.id, {
          worktreePath: item.worktreePath,
          pullRequestUrl: item.url,
          state,
          checkedAt,
        });
      }
    }
  }
}

/**
 * Runs {@link syncPullRequestStates} at most once per interval from the
 * handoff pass, which already runs on card changes and every lifecycle sweep
 * with the plugin's scope for the token read. The first run comes one
 * interval after the Gateway starts.
 */
export function createPullRequestStateSync(params: {
  store: WorkboardStore;
  github: WorkboardGitHubAccess;
  now: () => number;
}) {
  let lastRunAt = params.now();
  let running = false;
  return async (warn: (message: string) => void): Promise<void> => {
    if (running || params.now() - lastRunAt < PULL_REQUEST_SYNC_INTERVAL_MS) {
      return;
    }
    running = true;
    lastRunAt = params.now();
    try {
      await syncPullRequestStates({
        store: params.store,
        github: params.github,
        cards: await params.store.list(),
        now: params.now,
        warn,
      });
    } finally {
      running = false;
    }
  };
}
