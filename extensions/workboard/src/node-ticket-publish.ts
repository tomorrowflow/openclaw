import type { WorkboardCard } from "@openclaw/workboard-contract";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { readResponseWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { HandoffSupersededError, nodeTicketTarget, requireHostGit } from "./node-ticket.js";
import type { WorkboardStore } from "./store.js";

const GITHUB_API_URL = "https://api.github.com";
const GITHUB_API_TIMEOUT_MS = 30_000;
const GITHUB_API_MAX_BYTES = 1024 * 1024;
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
  };
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

/** Pushes the imported commit and returns the open draft PR for it, creating one when needed. */
async function pushAndOpenDraft(
  access: WorkboardGitHubAccess,
  item: PublishCard,
  assertCurrent: () => Promise<void>,
): Promise<string> {
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
  const existing = Array.isArray(open) ? htmlUrl(open[0]) : undefined;
  if (existing) {
    return existing;
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
  return created;
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
  let pullRequestUrl: string;
  try {
    pullRequestUrl = await pushAndOpenDraft(params.github, item, async () => {
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
}
