import type {
  WorkboardAutoMergeWait,
  WorkboardAutoMergeWaitCause,
  WorkboardBoardSummary,
  WorkboardCard,
} from "@openclaw/workboard-contract";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { matchHeldPaths } from "./held-paths.js";
import {
  GITHUB_PULL_URL_PATTERN,
  githubApi,
  githubRepo,
  type WorkboardGitHubAccess,
} from "./node-ticket-publish.js";
import { nodeTicketTarget } from "./node-ticket.js";
import { cardBoardId } from "./store-card-helpers.js";
import type { WorkboardStore } from "./store.js";

// Bounds one read of a long queue; the PRs behind it wait for the next pass.
const MAX_CANDIDATES_PER_REPO = 10;
// Each file carries its patch, and the response limit is 1 MiB.
const PULL_FILES_PER_PAGE = 30;
// GitHub lists at most 3000 files per PR; a larger diff is held as unknown.
const MAX_PULL_FILE_PAGES = 100;

type AutoMergeCandidate = {
  card: WorkboardCard;
  hostRepoPath: string;
  url: string;
  repo: string;
  number: number;
  /** The commit the agent accepted; the merge names it so nothing else merges. */
  headCommit: string;
  publishedAt: number;
  /** The board's one-way-door paths; empty when it has none. */
  heldPaths: readonly string[];
  /** The head a held-path wait was recorded at; that head is not read again. */
  heldAt?: string;
};

/**
 * A done ticket whose published PR is open and whose last round an agent
 * accepted at rung c. An operator's decision, a rework verdict, and a round
 * at a or b never merge here; nor does a draft or an archived card.
 */
function autoMergeCandidate(
  card: WorkboardCard,
  heldPaths: readonly string[],
): AutoMergeCandidate | undefined {
  const target = nodeTicketTarget(card);
  const worktree = target?.worktree;
  const handoff = worktree?.handoff;
  const latest = worktree?.reviews?.at(-1);
  if (
    !target ||
    handoff?.phase !== "published" ||
    handoff.pullRequest?.state !== "open" ||
    card.status !== "done" ||
    card.metadata?.archivedAt ||
    latest?.decidedBy !== "agent" ||
    latest.verdict !== "accept" ||
    latest.rung !== "c"
  ) {
    return undefined;
  }
  const match = GITHUB_PULL_URL_PATTERN.exec(handoff.pullRequestUrl);
  const wait = handoff.pullRequest.autoMergeWait;
  return match?.[1] && match[2]
    ? {
        card,
        hostRepoPath: target.hostRepoPath,
        url: handoff.pullRequestUrl,
        repo: match[1].toLowerCase(),
        number: Number(match[2]),
        headCommit: handoff.headCommit,
        publishedAt: handoff.publishedAt,
        heldPaths,
        ...(wait?.reason === "held_path" ? { heldAt: wait.headCommit } : {}),
      }
    : undefined;
}

type PullRead = {
  state?: string;
  mergeable?: string;
  headCommit?: string;
  checks?: string;
  changedFiles?: number;
};

function rollupState(commit: unknown): string | undefined {
  const rollup = isRecord(commit) ? commit.statusCheckRollup : undefined;
  return isRecord(rollup) && typeof rollup.state === "string" ? rollup.state : undefined;
}

function pullRead(value: unknown): PullRead {
  if (!isRecord(value)) {
    return {};
  }
  const nodes =
    isRecord(value.commits) && Array.isArray(value.commits.nodes) ? value.commits.nodes : [];
  const last = nodes.at(-1);
  const checks = isRecord(last) ? rollupState(last.commit) : undefined;
  return {
    ...(typeof value.state === "string" ? { state: value.state } : {}),
    ...(typeof value.mergeable === "string" ? { mergeable: value.mergeable } : {}),
    ...(typeof value.headRefOid === "string" ? { headCommit: value.headRefOid } : {}),
    ...(checks ? { checks } : {}),
    ...(typeof value.changedFiles === "number" ? { changedFiles: value.changedFiles } : {}),
  };
}

/** The base branch head's combined checks and each candidate PR's state, in one GraphQL read. */
async function readQueue(
  github: WorkboardGitHubAccess,
  token: string,
  repo: string,
  numbers: readonly number[],
): Promise<{ baseChecks?: string; pulls: PullRead[] }> {
  const [owner, name] = repo.split("/");
  const pulls = numbers
    .map(
      (number, index) =>
        `p${index}: pullRequest(number: ${number}) { state mergeable headRefOid changedFiles commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } }`,
    )
    .join("\n");
  const reply = await githubApi(github, token, "POST", "/graphql", {
    query: `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef { target { ... on Commit { statusCheckRollup { state } } } }
    ${pulls}
  }
}`,
    variables: { owner, name },
  });
  const errors = isRecord(reply) && Array.isArray(reply.errors) ? reply.errors : [];
  if (errors.length > 0) {
    throw new Error(`GitHub GraphQL: ${JSON.stringify(errors[0]).slice(0, 300)}`);
  }
  const repository = isRecord(reply) && isRecord(reply.data) ? reply.data.repository : undefined;
  const branch = isRecord(repository) ? repository.defaultBranchRef : undefined;
  const baseChecks = rollupState(isRecord(branch) ? branch.target : undefined);
  return {
    ...(baseChecks ? { baseChecks } : {}),
    pulls: numbers.map((_, index) =>
      pullRead(isRecord(repository) ? repository[`p${index}`] : undefined),
    ),
  };
}

/**
 * Whether the PR's diff touches a held path. `unknown` is a list GitHub did
 * not give whole: a failed read, a page cap, or fewer files than the PR
 * reports; it holds the merge like a match, without a record.
 */
type HeldPathResult =
  | { kind: "held"; paths: string[] }
  | { kind: "clear" }
  | { kind: "unknown"; detail: string };

/**
 * Reads the PR's changed files through the REST list, which names both
 * sides of a rename and a deleted file, and matches them against the held
 * paths. The GraphQL `changedFiles` count proves the paged list complete.
 */
async function readHeldPaths(
  github: WorkboardGitHubAccess,
  token: string,
  repo: string,
  candidate: AutoMergeCandidate,
  changedFiles: number | undefined,
): Promise<HeldPathResult> {
  if (changedFiles === undefined) {
    return { kind: "unknown", detail: "GitHub did not report the PR's file count" };
  }
  const files: string[] = [];
  let listed = 0;
  try {
    for (let page = 1; page <= MAX_PULL_FILE_PAGES; page += 1) {
      const reply = await githubApi(
        github,
        token,
        "GET",
        `/repos/${repo}/pulls/${candidate.number}/files?per_page=${PULL_FILES_PER_PAGE}&page=${page}`,
      );
      const entries = Array.isArray(reply) ? reply : [];
      listed += entries.length;
      for (const entry of entries) {
        if (!isRecord(entry)) {
          continue;
        }
        for (const path of [entry.filename, entry.previous_filename]) {
          if (typeof path === "string" && !files.includes(path)) {
            files.push(path);
          }
        }
      }
      if (entries.length < PULL_FILES_PER_PAGE) {
        break;
      }
    }
  } catch (error) {
    return { kind: "unknown", detail: formatErrorMessage(error) };
  }
  if (listed !== changedFiles) {
    return {
      kind: "unknown",
      detail: `GitHub listed ${listed} of the PR's ${changedFiles} changed files`,
    };
  }
  const paths = matchHeldPaths(candidate.heldPaths, files);
  return paths.length ? { kind: "held", paths } : { kind: "clear" };
}

const WAIT_NOTICES: Record<Exclude<WorkboardAutoMergeWait, "held_path">, string> = {
  base_red:
    "the base branch's checks are red, so the rung c merge queue is halted. It resumes on its own once the base branch is green again.",
  checks_failed:
    "this PR's checks failed. It stays open for the operator; the PRs behind it merge meanwhile.",
  checks_missing:
    "this PR's head has no checks, and rung c merges only a PR whose checks passed. It stays open for the operator.",
  head_moved:
    "the PR's head is no longer the commit the agent accepted, so Workboard will not merge it. It stays open for the operator.",
};

function waitNotice(wait: WorkboardAutoMergeWaitCause): string {
  return wait.reason === "held_path"
    ? `the PR touches a held path (${wait.paths.map((path) => `\`${path}\``).join(", ")}), which only the operator merges. It stays open for the operator; the PRs behind it merge meanwhile.`
    : WAIT_NOTICES[wait.reason];
}

/**
 * Merges agent-accepted rung c PRs one at a time, oldest publish first, per
 * repository (rung c, D37). A pass merges at most one PR per repository and
 * only while the base branch's head checks are green: right after a merge
 * its merge commit's checks are pending, so the next PR waits for them, and
 * a red base branch halts the queue until it is green again. A candidate
 * merges when GitHub reports it open and mergeable, its head is still the
 * accepted commit, its own checks passed, and, on a board with `heldPaths`,
 * its diff touches none of them; the merge names that commit, so a push that
 * lands meanwhile makes GitHub refuse it. Pending checks or an unknown
 * mergeability hold the queue; a conflict is the PR state sync's to reopen.
 * Failed or missing checks, a moved head, and a held path pass the PR over
 * with a notice, once per cause; a file list GitHub did not give whole holds
 * the PR with a warning until a later pass reads it. The merge is recorded
 * with the merge facts the regression watch reads. A failure warns, and the
 * next pass retries.
 */
export async function runAutoMergeQueue(params: {
  store: Pick<WorkboardStore, "recordAutoMerge" | "setAutoMergeWait">;
  github: WorkboardGitHubAccess;
  cards: readonly WorkboardCard[];
  boards: ReadonlyArray<Pick<WorkboardBoardSummary, "id" | "orchestration">>;
  now: () => number;
  warn: (message: string) => void;
}): Promise<void> {
  const heldPathsByBoard = new Map(
    params.boards.map((board) => [board.id, board.orchestration?.heldPaths ?? []]),
  );
  const candidates = params.cards
    .flatMap(
      (card) => autoMergeCandidate(card, heldPathsByBoard.get(cardBoardId(card)) ?? []) ?? [],
    )
    .toSorted((a, b) => a.publishedAt - b.publishedAt);
  const byRepo = new Map<string, { token: string; queue: AutoMergeCandidate[] }>();
  const hosts = new Map<string, Promise<{ repo: string; token: string }>>();
  for (const candidate of candidates) {
    const host =
      hosts.get(candidate.hostRepoPath) ?? githubRepo(params.github, candidate.hostRepoPath);
    hosts.set(candidate.hostRepoPath, host);
    try {
      const { repo, token } = await host;
      // A re-pointed origin must not merge in another repository.
      if (candidate.repo !== repo.toLowerCase()) {
        continue;
      }
      const entry = byRepo.get(repo) ?? { token, queue: [] };
      entry.queue.push(candidate);
      byRepo.set(repo, entry);
    } catch (error) {
      params.warn(
        `workboard auto-merge skipped ${candidate.card.id}: ${formatErrorMessage(error)}`,
      );
    }
  }
  const wait = async (candidate: AutoMergeCandidate, cause: WorkboardAutoMergeWaitCause) =>
    await params.store.setAutoMergeWait(candidate.card.id, {
      pullRequestUrl: candidate.url,
      at: params.now(),
      wait: cause,
      notice: `**Auto-merge waits:** ${waitNotice(cause)}`,
    });
  for (const [repo, { token, queue }] of byRepo) {
    const head = queue.slice(0, MAX_CANDIDATES_PER_REPO);
    try {
      const { baseChecks, pulls } = await readQueue(
        params.github,
        token,
        repo,
        head.map((candidate) => candidate.number),
      );
      if (baseChecks === "FAILURE" || baseChecks === "ERROR") {
        // The oldest candidate carries the halt notice; the others wait behind it.
        const [first] = head;
        if (first) {
          await wait(first, { reason: "base_red" });
        }
        continue;
      }
      if (baseChecks !== "SUCCESS") {
        continue;
      }
      for (const [index, candidate] of head.entries()) {
        const pull = pulls[index] ?? {};
        if (pull.state !== "OPEN") {
          continue;
        }
        const reason =
          pull.headCommit !== candidate.headCommit
            ? "head_moved"
            : pull.checks === "FAILURE" || pull.checks === "ERROR"
              ? "checks_failed"
              : pull.checks === undefined
                ? "checks_missing"
                : undefined;
        if (reason) {
          await wait(candidate, { reason });
          continue;
        }
        if (candidate.heldPaths.length) {
          // The accepted head was read before and still held: no read, no new notice.
          if (candidate.heldAt === candidate.headCommit) {
            continue;
          }
          const held = await readHeldPaths(
            params.github,
            token,
            repo,
            candidate,
            pull.changedFiles,
          );
          if (held.kind === "unknown") {
            params.warn(
              `workboard auto-merge holds ${candidate.card.id}: ${held.detail}; the next pass reads the PR's files again`,
            );
            continue;
          }
          if (held.kind === "held") {
            await wait(candidate, {
              reason: "held_path",
              headCommit: candidate.headCommit,
              paths: held.paths,
            });
            continue;
          }
        }
        if (pull.checks !== "SUCCESS" || pull.mergeable !== "MERGEABLE") {
          break;
        }
        const merged = await githubApi(
          params.github,
          token,
          "PUT",
          `/repos/${repo}/pulls/${candidate.number}/merge`,
          { merge_method: "merge", sha: candidate.headCommit },
        );
        const mergeCommit = isRecord(merged) ? merged.sha : undefined;
        if (typeof mergeCommit !== "string" || !mergeCommit) {
          // The PR state sync records this merge from GitHub's side on its next read.
          throw new Error(`GitHub merged #${candidate.number} without naming its merge commit`);
        }
        const mergedAt = params.now();
        await params.store.recordAutoMerge(candidate.card.id, {
          pullRequestUrl: candidate.url,
          mergedAt,
          mergeCommit,
          notice: `**Auto-merged** at rung c as ${mergeCommit.slice(0, 7)}: the agent accepted the round and the PR's checks passed. The regression watch follows it for 7 days.`,
        });
        break;
      }
    } catch (error) {
      params.warn(`workboard auto-merge failed for ${repo}: ${formatErrorMessage(error)}`);
    }
  }
}
