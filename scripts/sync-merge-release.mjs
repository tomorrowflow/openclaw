#!/usr/bin/env node
// Starts a merge-based upstream sync on a clean `main` checkout and applies the
// mechanical resolutions, so the sync agent only sees conflicts that need
// judgment. Deterministic and idempotent per target: rerunning it after
// `git merge --abort` produces the same state.
//
// Usage: node scripts/sync-merge-release.mjs <X.Y.Z>
// Prints one JSON line: {"state":"up-to-date"|"merging", ...}.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const CI_PATHS = [
  ".github/workflows",
  ".github/actions",
  ".github/codeql",
  ".github/dependabot.yml",
  ".github/actionlint.yaml",
];

const RELEASE_OWNED = [
  /(^|\/)CHANGELOG\.md$/,
  /^docs\/\.generated\//,
  /^apps\/macos\/Sources\/OpenClaw\/Resources\/Info\.plist$/,
  /^scripts\/lib\/official-external-channel-catalog\.json$/,
];

function git(args, options = {}) {
  return execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    ...options,
  }).trim();
}

function blob(ref, file) {
  const result = spawnSync("git", ["show", `${ref}:${file}`], { maxBuffer: 256 * 1024 * 1024 });
  return result.status === 0 ? result.stdout : undefined;
}

/**
 * Keeps every change both sides made and takes the release's side only inside
 * conflict hunks. A file one side deleted is a judgment call, not a hunk merge,
 * so it stays for the agent: returns false.
 */
function resolveHunksToRelease(file, base, release) {
  const ours = blob("HEAD", file);
  const theirs = blob(release, file);
  if (ours === undefined || theirs === undefined) {
    return false;
  }
  const dir = mkdtempSync(path.join(tmpdir(), "sync-merge-"));
  try {
    const sides = [
      ["ours", ours],
      ["base", blob(base, file)],
      ["theirs", theirs],
    ].map(([name, data]) => {
      const target = path.join(dir, name);
      writeFileSync(target, data ?? "");
      return target;
    });
    const merged = spawnSync("git", ["merge-file", "-p", "--theirs", ...sides], {
      maxBuffer: 256 * 1024 * 1024,
    });
    writeFileSync(file, merged.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  git(["add", "--", file]);
  return true;
}

/** NUL-separated paths: never quoted, whatever characters a path holds. */
function paths(args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 })
    .split("\0")
    .filter(Boolean);
}

function unmergedFiles() {
  return [...new Set(paths(["diff", "-z", "--name-only", "--diff-filter=U"]))];
}

function main(target) {
  if (!/^\d+\.\d+\.\d+$/.test(target ?? "")) {
    throw new Error("usage: sync-merge-release.mjs <X.Y.Z>");
  }
  const release = `upstream/release/${target}`;
  git(["rev-parse", "--verify", "--quiet", `${release}^{commit}`]);
  if (existsSync(path.join(git(["rev-parse", "--git-dir"]), "MERGE_HEAD"))) {
    throw new Error("a merge is already in progress; `git merge --abort` it first");
  }
  if (git(["status", "--porcelain", "--untracked-files=no"])) {
    throw new Error("tracked files have uncommitted changes");
  }
  const upstreamCommits = Number(git(["rev-list", "--count", `HEAD..${release}`]));
  if (upstreamCommits === 0) {
    return { state: "up-to-date", target, upstreamCommits };
  }
  const base = git(["merge-base", "HEAD", release]);
  // A conflicting merge exits 1 with the conflicts in the index. Anything else
  // (an untracked file in the way, a missing ref) never started the merge.
  const merge = spawnSync("git", ["merge", "--no-ff", "--no-commit", release], {
    encoding: "utf8",
  });
  if (
    (merge.status !== 0 && merge.status !== 1) ||
    !existsSync(path.join(git(["rev-parse", "--git-dir"]), "MERGE_HEAD"))
  ) {
    throw new Error(`git merge did not start: ${(merge.stderr || merge.stdout).trim()}`);
  }
  const conflicted = unmergedFiles().length;
  const mechanical = {};
  const note = (rule, file) => (mechanical[rule] ??= []).push(file);

  // The fork removed upstream CI. Whatever CI the release adds, or changes
  // where the fork deleted it, stays out; CI files the fork kept stay.
  const forkFiles = new Set(paths(["ls-tree", "-z", "-r", "--name-only", "HEAD", "--", ".github"]));
  // ls-files lists an unmerged path once per index stage.
  for (const file of new Set(paths(["ls-files", "-z", "--", ...CI_PATHS]))) {
    if (!forkFiles.has(file)) {
      git(["rm", "-q", "-f", "--", file]);
      note("upstream-ci-removed", file);
    }
  }

  for (const file of unmergedFiles()) {
    const releaseOwned = RELEASE_OWNED.some((pattern) => pattern.test(file));
    if (file === "pnpm-lock.yaml") {
      // The agent reinstalls, which re-resolves the fork's own additions on top.
      git(["checkout", "--theirs", "--", file]);
      git(["add", "--", file]);
      note("lockfile-release", file);
    } else if (file.endsWith("package.json") || releaseOwned) {
      if (resolveHunksToRelease(file, base, release)) {
        note(releaseOwned ? "release-owned" : "package-json-hunks", file);
      }
    } else {
      // No fork commit changed it, only another release cut's commits (which
      // are in upstream refs): the target carries that change, evolved.
      const forkCommits = git([
        "rev-list",
        `${base}..HEAD`,
        "--not",
        "--remotes=upstream",
        "--",
        file,
      ]);
      if (!forkCommits) {
        git(["checkout", "--theirs", "--", file]);
        git(["add", "--", file]);
        note("previous-release-cut", file);
      }
    }
  }

  // The fork deploys the clean train version and its own deploy script.
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  if (pkg.version !== target || !pkg.scripts?.["deploy:globally"]) {
    pkg.version = target;
    pkg.scripts = { ...pkg.scripts, "deploy:globally": "node scripts/deploy-globally.mjs" };
    writeFileSync("package.json", `${JSON.stringify(pkg, null, 2)}\n`);
    git(["add", "--", "package.json"]);
    note("root-version-pin", "package.json");
  }

  return {
    state: "merging",
    target,
    upstreamCommits,
    base,
    conflicted,
    mechanical,
    remaining: unmergedFiles(),
  };
}

console.log(JSON.stringify(main(process.argv[2])));
