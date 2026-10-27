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

// GraphQL, not the REST list: a REST page carries every PR body, and 100 of
// them outgrow the 1 MiB response cap on a busy repository.
const PULL_STATES_QUERY = `query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: ${PULLS_PER_PAGE}, after: $after, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes { number state isDraft mergeable }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

function pullRequestState(pull: Record<string, unknown>): WorkboardPullRequestState | undefined {
  switch (pull.state) {
    case "MERGED":
      return "merged";
    case "CLOSED":
      return "closed";
    case "OPEN":
      return pull.isDraft === true ? "draft" : "open";
    default:
      return undefined;
  }
}

/** One page of the repository's PRs, newest update first; GraphQL errors arrive with a 200. */
async function pullStatesPage(
  github: WorkboardGitHubAccess,
  token: string,
  repo: string,
  after: string | undefined,
): Promise<{ pulls: unknown[]; next?: string }> {
  const [owner, name] = repo.split("/");
  const reply = await githubApi(github, token, "POST", "/graphql", {
    query: PULL_STATES_QUERY,
    variables: { owner, name, after: after ?? null },
  });
  const errors = isRecord(reply) && Array.isArray(reply.errors) ? reply.errors : [];
  if (errors.length > 0) {
    throw new Error(`GitHub GraphQL: ${JSON.stringify(errors[0]).slice(0, 300)}`);
  }
  const connection =
    isRecord(reply) && isRecord(reply.data) && isRecord(reply.data.repository)
      ? reply.data.repository.pullRequests
      : undefined;
  const pageInfo = isRecord(connection) ? connection.pageInfo : undefined;
  return {
    pulls: isRecord(connection) && Array.isArray(connection.nodes) ? connection.nodes : [],
    ...(isRecord(pageInfo) &&
    pageInfo.hasNextPage === true &&
    typeof pageInfo.endCursor === "string"
      ? { next: pageInfo.endCursor }
      : {}),
  };
}

/**
 * Reads the GitHub state of every published node ticket PR not yet seen
 * merged or closed, with one paged GraphQL query per repository, and records the
 * changed ones. A done ticket whose open PR conflicts with its base is reopened
 * for a rework round that merges the base. Repositories and tokens come from
 * the host clones' origins, as for the publish. A failure leaves the last known
 * state and warns.
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
    const conflicting = new Set<number>();
    try {
      let after: string | undefined;
      for (let page = 1; page <= MAX_PAGES_PER_REPO && found.size < wanted.size; page += 1) {
        const { pulls, next } = await pullStatesPage(params.github, token, repo, after);
        for (const pull of pulls) {
          if (!isRecord(pull) || typeof pull.number !== "number" || !wanted.has(pull.number)) {
            continue;
          }
          const state = pullRequestState(pull);
          if (state) {
            found.set(pull.number, state);
          }
          // GitHub computes mergeability lazily: UNKNOWN now resolves by a later sync.
          if (pull.state === "OPEN" && pull.mergeable === "CONFLICTING") {
            conflicting.add(pull.number);
          }
        }
        if (!next) {
          break;
        }
        after = next;
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
    for (const number of conflicting) {
      for (const item of wanted.get(number) ?? []) {
        await params.store.reopenConflictingPullRequest(item.card.id, {
          worktreePath: item.worktreePath,
          pullRequestUrl: item.url,
          now: checkedAt,
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
