import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = path.join(process.cwd(), "scripts", "sync-merge-release.mjs");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function pkg(version: string, extra: Record<string, unknown> = {}) {
  return `${JSON.stringify({ name: "app", version, ...extra }, null, 2)}\n`;
}

/**
 * A fork `main` and two upstream release cuts from one base: release/1.0.0 (an
 * earlier cut the fork merged) and release/1.0.1 (the sync target).
 */
function makeFork() {
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-sync-merge-"));
  roots.push(root);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const write = (files: Record<string, string | null>) => {
    for (const [file, body] of Object.entries(files)) {
      const target = path.join(root, file);
      if (body === null) {
        git("rm", "-q", file);
        continue;
      }
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, body);
      git("add", file);
    }
  };
  const commit = (message: string, files: Record<string, string | null>) => {
    write(files);
    git("commit", "-q", "-m", message);
    return git("rev-parse", "HEAD");
  };
  git("init", "-q", "-b", "main");
  git("config", "user.name", "fork");
  git("config", "user.email", "fork@example.test");
  git("config", "commit.gpgsign", "false");
  const extension = (version: string, fork = false) =>
    `${JSON.stringify(
      {
        name: "@app/a",
        version,
        description: "a",
        license: "MIT",
        keywords: ["a"],
        ...(fork ? { fork: true } : {}),
      },
      null,
      2,
    )}\n`;
  const base = commit("base", {
    "package.json": pkg("1.0.0-beta.1"),
    "extensions/a/package.json": extension("1.0.0-beta.1"),
    "CHANGELOG.md": "base\n",
    "src/fork.ts": "export const x = 1;\n",
    "src/oldcut.ts": "a\n",
    ".github/workflows/ci.yml": "ci\n",
  });
  git("checkout", "-q", "-b", "cut-1.0.0", base);
  git(
    "update-ref",
    "refs/remotes/upstream/release/1.0.0",
    commit("old cut", { "src/oldcut.ts": "a-old\n" }),
  );
  git("checkout", "-q", "-b", "cut-1.0.1", base);
  git(
    "update-ref",
    "refs/remotes/upstream/release/1.0.1",
    commit("release 1.0.1", {
      "package.json": pkg("1.0.1-beta.1"),
      "extensions/a/package.json": extension("1.0.1-beta.1"),
      "CHANGELOG.md": "release notes\n",
      "src/fork.ts": "export const x = 3;\n",
      "src/oldcut.ts": "a-new\n",
      ".github/workflows/ci.yml": "ci v2\n",
      ".github/workflows/new.yml": "new\n",
    }),
  );
  git("checkout", "-q", "main");
  git("merge", "-q", "--no-ff", "-m", "merge old cut", "upstream/release/1.0.0");
  commit("fork work", {
    "package.json": pkg("1.0.0", {
      scripts: { "deploy:globally": "node scripts/deploy-globally.mjs" },
    }),
    "extensions/a/package.json": extension("1.0.0", true),
    "CHANGELOG.md": "fork note\n",
    "src/fork.ts": "export const x = 2;\n",
    ".github/workflows/ci.yml": null,
    ".github/workflows/fork-x.yml": "fork ci\n",
  });
  return { root, git };
}

function run(root: string, target: string) {
  return JSON.parse(execFileSync("node", [SCRIPT, target], { cwd: root, encoding: "utf8" }));
}

describe("sync-merge-release", () => {
  it("resolves the mechanical conflicts and leaves only the fork's source conflict", () => {
    const { root, git } = makeFork();

    const result = run(root, "1.0.1");

    expect(result).toMatchObject({ state: "merging", target: "1.0.1", remaining: ["src/fork.ts"] });
    expect(Object.keys(result.mechanical).toSorted()).toEqual([
      "package-json-hunks",
      "previous-release-cut",
      "release-owned",
      "root-version-pin",
      "upstream-ci-removed",
    ]);
    const read = (file: string) => readFileSync(path.join(root, file), "utf8");
    expect(JSON.parse(read("package.json"))).toMatchObject({
      version: "1.0.1",
      scripts: { "deploy:globally": "node scripts/deploy-globally.mjs" },
    });
    // The version hunk takes the release; the fork's other change stays.
    expect(JSON.parse(read("extensions/a/package.json"))).toMatchObject({
      version: "1.0.1-beta.1",
      fork: true,
    });
    expect(read("CHANGELOG.md")).toBe("release notes\n");
    expect(read("src/oldcut.ts")).toBe("a-new\n");
    expect(existsSync(path.join(root, ".github/workflows/fork-x.yml"))).toBe(true);
    expect(git("ls-files", ".github")).toBe(".github/workflows/fork-x.yml");
    expect(git("rev-parse", "--verify", "MERGE_HEAD")).toBe(
      git("rev-parse", "upstream/release/1.0.1"),
    );
  });

  it("leaves a package.json the release deleted to the agent instead of emptying it", () => {
    const { root, git } = makeFork();
    git("checkout", "-q", "cut-1.0.1");
    git("rm", "-q", "extensions/a/package.json");
    git("commit", "-q", "-m", "drop extension a");
    git("update-ref", "refs/remotes/upstream/release/1.0.1", git("rev-parse", "HEAD"));
    git("checkout", "-q", "main");

    const result = run(root, "1.0.1");

    expect(result.remaining).toContain("extensions/a/package.json");
    expect(result.mechanical["package-json-hunks"]).not.toContain("extensions/a/package.json");
    expect(
      JSON.parse(readFileSync(path.join(root, "extensions/a/package.json"), "utf8")),
    ).toMatchObject({
      fork: true,
    });
  });

  it("fails without reporting a merge when git cannot start one", () => {
    const { root } = makeFork();
    // An untracked file where the release adds one blocks the merge outright.
    mkdirSync(path.join(root, ".github/workflows"), { recursive: true });
    writeFileSync(path.join(root, ".github/workflows/new.yml"), "local\n");

    expect(() => run(root, "1.0.1")).toThrow(/git merge did not start/);
    expect(existsSync(path.join(root, ".git/MERGE_HEAD"))).toBe(false);
  });

  it("changes nothing when main already contains the release", () => {
    const { root, git } = makeFork();
    git("merge", "-q", "-s", "ours", "-m", "record", "upstream/release/1.0.1");
    const head = git("rev-parse", "HEAD");

    expect(run(root, "1.0.1")).toEqual({
      state: "up-to-date",
      target: "1.0.1",
      upstreamCommits: 0,
    });
    expect(git("rev-parse", "HEAD")).toBe(head);
    expect(git("status", "--porcelain")).toBe("");
  });
});
