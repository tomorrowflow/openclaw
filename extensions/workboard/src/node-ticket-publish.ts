import type {
  WorkboardCard,
  WorkboardNodeReviewVerdict,
  WorkboardNodeRework,
} from "@openclaw/workboard-contract";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { readResponseWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  HandoffSupersededError,
  nodeTicketTarget,
  requireHostGit,
  reviewVerdictOf,
} from "./node-ticket.js";
import type { WorkboardStore } from "./store.js";

const GITHUB_API_URL = "https://api.github.com";
const GITHUB_API_TIMEOUT_MS = 30_000;
const GITHUB_API_MAX_BYTES = 1024 * 1024;
// Keeps a rework PR comment well under GitHub's 65,536-character body limit.
const REWORK_COMMENT_MAX_CHARS = 1500;
const REWORK_COMMENT_MAX_ENTRIES = 10;
const GITHUB_ISSUE_URL_PATTERN = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)\/?$/;
const GITHUB_ORIGIN_PATTERN =
  /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/;

/**
 * The host-only GitHub access for draft PRs (D43). Tokens come from operator
 * config keyed by the host clone's origin, so card or board data can never
 * pick the token or the repository it is sent to.
 */
export type WorkboardGitHubAccess = {
  token(repo: string): string | undefined;
  fetch?: typeof fetch;
  /** Where the branch is pushed; tests point it at a local remote. */
  remoteUrl?: (repo: string) => string;
};

type PublishCard = {
  card: WorkboardCard;
  hostRepoPath: string;
  worktreePath: string;
  branch: string;
  headCommit: string;
  importedAt: number;
  rework?: WorkboardNodeRework;
};

export function publishCandidate(card: WorkboardCard): PublishCard | undefined {
  const target = nodeTicketTarget(card);
  const worktree = target?.worktree;
  const handoff = worktree?.handoff;
  if (
    !target ||
    !worktree ||
    handoff?.phase !== "imported" ||
    card.status !== "done" ||
    card.metadata?.archivedAt
  ) {
    return undefined;
  }
  return {
    card,
    hostRepoPath: target.hostRepoPath,
    worktreePath: worktree.path,
    branch: worktree.branch,
    headCommit: handoff.headCommit,
    importedAt: handoff.importedAt,
    ...(worktree.rework ? { rework: worktree.rework } : {}),
  };
}

/**
 * The shadow verdict on the round being published: the newest agent comment
 * starting with `Verdict:` since the import and no later than the operator's
 * move to done, so a verdict that arrives after the decision counts as missed.
 */
function reviewVerdict(item: PublishCard): WorkboardNodeReviewVerdict {
  const { card } = item;
  const decidedAt =
    card.events?.findLast((event) => event.toStatus === "done")?.at ?? Number.POSITIVE_INFINITY;
  const verdict = (card.metadata?.comments ?? [])
    .filter((comment) => comment.createdAt >= item.importedAt && comment.createdAt <= decidedAt)
    .flatMap((comment) => reviewVerdictOf(comment) ?? [])
    .at(-1);
  return { round: item.rework?.round ?? 0, verdict: verdict ?? "missed" };
}

/** A card created from a GitHub issue names it as its source; merging the PR closes it. */
function closesIssue(card: WorkboardCard): string | undefined {
  const match = card.sourceUrl?.match(GITHUB_ISSUE_URL_PATTERN);
  return match ? `Closes ${match[1]}#${match[2]}` : undefined;
}

function pullRequestBody(card: WorkboardCard, headCommit: string): string {
  const proof = (card.metadata?.proof ?? [])
    .filter((entry) => entry.label === "ticket proof")
    .map(
      (entry) => `- ${entry.status}: ${entry.command ? `\`${entry.command}\`` : "(no command)"}`,
    );
  return [
    card.notes?.trim(),
    proof.length > 0 ? ["Ticket proof:", ...proof].join("\n") : undefined,
    closesIssue(card),
    `Workboard card \`${card.id}\` at ${headCommit}.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function githubApi(
  access: WorkboardGitHubAccess,
  token: string,
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>,
): Promise<unknown> {
  const response = await (access.fetch ?? fetch)(`${GITHUB_API_URL}${path}`, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS),
  });
  const text = (await readResponseWithLimit(response, GITHUB_API_MAX_BYTES)).toString("utf8");
  const json: unknown = text ? JSON.parse(text) : undefined;
  if (!response.ok) {
    const message = isRecord(json) && typeof json.message === "string" ? json.message : text;
    throw new Error(
      `GitHub ${method} ${path} returned ${response.status}: ${message.slice(0, 300)}`,
    );
  }
  return json;
}

function htmlUrl(value: unknown): string | undefined {
  return isRecord(value) && typeof value.html_url === "string" ? value.html_url : undefined;
}

/** The PR the branch was pushed to; `reused` carries what commenting on an already open one needs. */
type DraftPullRequest = {
  url: string;
  reused?: { repo: string; token: string; number: number };
};

/** Pushes the imported commit and returns the open draft PR for it, creating one when needed. */
async function pushAndOpenDraft(
  access: WorkboardGitHubAccess,
  item: PublishCard,
  assertCurrent: () => Promise<void>,
): Promise<DraftPullRequest> {
  const { hostRepoPath, branch, headCommit, card } = item;
  const origin = await requireHostGit(hostRepoPath, ["remote", "get-url", "origin"]);
  const repo = GITHUB_ORIGIN_PATTERN.exec(origin)?.[1];
  if (!repo) {
    throw new Error(`the host clone's origin ${origin} is not a github.com repository`);
  }
  const token = access.token(repo);
  if (!token) {
    throw new Error(
      `no GitHub token for ${repo}; set plugins.entries.workboard.config.github.repos["${repo}"].token to a SecretRef, then run \`openclaw secrets reload\``,
    );
  }
  const local = await requireHostGit(hostRepoPath, [
    "rev-parse",
    "--verify",
    `refs/heads/${branch}`,
  ]);
  if (local !== headCommit) {
    throw new Error(
      `${branch} moved from the imported ${headCommit} to ${local} in the host clone`,
    );
  }
  await assertCurrent();
  // The token travels as an environment-only header, never in argv or the clone's config.
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  await requireHostGit(
    hostRepoPath,
    [
      "push",
      "--quiet",
      access.remoteUrl?.(repo) ?? `https://github.com/${repo}.git`,
      `${headCommit}:refs/heads/${branch}`,
    ],
    {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
    },
  );
  const owner = repo.split("/")[0];
  const open = await githubApi(
    access,
    token,
    "GET",
    `/repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`,
  );
  const first: unknown = Array.isArray(open) ? open[0] : undefined;
  const existing = htmlUrl(first);
  if (existing) {
    const number = isRecord(first) ? first.number : undefined;
    return {
      url: existing,
      ...(typeof number === "number" ? { reused: { repo, token, number } } : {}),
    };
  }
  const repository = await githubApi(access, token, "GET", `/repos/${repo}`);
  const base = isRecord(repository) ? repository.default_branch : undefined;
  if (typeof base !== "string" || !base) {
    throw new Error(`GitHub did not report a default branch for ${repo}`);
  }
  const created = htmlUrl(
    await githubApi(access, token, "POST", `/repos/${repo}/pulls`, {
      title: card.title,
      head: branch,
      base,
      body: pullRequestBody(card, headCommit),
      draft: true,
    }),
  );
  if (!created) {
    throw new Error(`GitHub created no pull request URL for ${repo} ${branch}`);
  }
  return { url: created };
}

function quote(text: string): string {
  const capped =
    text.length > REWORK_COMMENT_MAX_CHARS ? `${text.slice(0, REWORK_COMMENT_MAX_CHARS)}…` : text;
  return capped
    .trim()
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

/**
 * The reused PR keeps the first round's body, so a rework round (D54) is told
 * as a PR comment. The card comments since the previous publish carry the
 * review feedback that reopened it and the session's done summary.
 */
function reworkCommentBody(item: PublishCard, rework: WorkboardNodeRework): string {
  const { card } = item;
  const previousPublish = card.metadata?.proof?.findLast(
    (entry) => entry.label === "draft PR" && entry.status === "passed",
  )?.createdAt;
  const comments = (card.metadata?.comments ?? [])
    .filter((comment) => previousPublish === undefined || comment.createdAt >= previousPublish)
    .slice(-REWORK_COMMENT_MAX_ENTRIES);
  const outside = rework.outsideCommits;
  return [
    `Rework round ${rework.round} pushed \`${item.headCommit.slice(0, 12)}\` to this PR.`,
    outside > 0
      ? `${outside} commit${outside === 1 ? "" : "s"} pushed by others since the first publish.`
      : undefined,
    comments.length > 0
      ? ["Card comments this round:", ...comments.map((comment) => quote(comment.body))].join(
          "\n\n",
        )
      : undefined,
    `Workboard card \`${card.id}\`.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * D43: an accepted node ticket (moved to done after its import) becomes one
 * draft PR. A failure blocks the card with the reason; moving it to done
 * again retries, and an already open PR for the branch is reused.
 */
export async function publishNodeTicket(params: {
  store: WorkboardStore;
  github: WorkboardGitHubAccess;
  item: PublishCard;
  now: () => number;
}): Promise<void> {
  const { store, item } = params;
  const { card } = item;
  const claim = card.metadata?.claim;
  const scope = claim ? { ownerId: claim.ownerId, token: claim.token } : undefined;
  let pullRequest: DraftPullRequest;
  try {
    pullRequest = await pushAndOpenDraft(params.github, item, async () => {
      const current = await store.get(card.id);
      const fresh = current ? publishCandidate(current) : undefined;
      if (
        !fresh ||
        fresh.hostRepoPath !== item.hostRepoPath ||
        fresh.worktreePath !== item.worktreePath ||
        fresh.headCommit !== item.headCommit
      ) {
        throw new HandoffSupersededError();
      }
    });
  } catch (error) {
    if (error instanceof HandoffSupersededError) {
      return;
    }
    await store.block(
      card.id,
      {
        reason: `Draft PR failed: ${formatErrorMessage(error)}\nFix the cause, then move the card to done again to retry.`,
      },
      scope,
    );
    return;
  }
  const pullRequestUrl = pullRequest.url;
  await store.setNodeHandoff(
    card.id,
    {
      worktreePath: item.worktreePath,
      handoff: {
        phase: "published",
        headCommit: item.headCommit,
        importedAt: item.importedAt,
        publishedAt: params.now(),
        pullRequestUrl,
      },
      review: reviewVerdict(item),
    },
    scope,
  );
  await store.addProof(
    card.id,
    {
      label: "draft PR",
      status: "passed",
      url: pullRequestUrl,
      command: `git push origin ${item.headCommit.slice(0, 12)}:${item.branch}`,
    },
    scope,
  );
  // Posting after the published record keeps it to one comment per round: a
  // published handoff is never a publish candidate again.
  const { reused } = pullRequest;
  if (!item.rework || !reused) {
    return;
  }
  try {
    await githubApi(
      params.github,
      reused.token,
      "POST",
      `/repos/${reused.repo}/issues/${reused.number}/comments`,
      { body: reworkCommentBody(item, item.rework) },
    );
  } catch (error) {
    await store.addNodeTicketNotice(
      card.id,
      {
        worktreePath: item.worktreePath,
        kind: "reviewFrom",
        body: `Rework round ${item.rework.round} was pushed to ${pullRequestUrl}, but its PR comment failed: ${formatErrorMessage(error)}`,
        applies: () => true,
      },
      scope,
    );
  }
}
