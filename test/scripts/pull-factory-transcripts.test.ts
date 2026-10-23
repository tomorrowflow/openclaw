import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { userInfo } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => afterEach(cleanup));
const SCRIPT = resolve("scripts/pull-factory-transcripts.sh");

const CONTRACT_FILES = [
  "commands/hello.md",
  "commands/sub/deep.md",
  "plugins/cache/m/p/0.9/.claude-plugin/plugin.json",
  "plugins/cache/m/p/0.9/skills/ps/SKILL.md",
  "plugins/cache/m/p/1.0/.claude-plugin/plugin.json",
  "plugins/cache/m/p/1.0/commands/pc.md",
  "plugins/cache/m/p/1.0/skills/ps/SKILL.md",
  "plugins/installed_plugins.json",
  "plugins/synced/sp/.claude-plugin/plugin.json",
  "plugins/synced/sp/skills/ss/SKILL.md",
  "skills/cat/nested/SKILL.md",
  "skills/personal/SKILL.md",
];
const PRIVATE_FILES = [
  ".credentials.json",
  "commands/notes.txt",
  "history.jsonl",
  "plugins/cache/m/p/1.0/README.md",
  "plugins/cache/m/p/1.0/skills/ps/run.py",
  "plugins/data/x",
  "plugins/known_marketplaces.json",
  "plugins/marketplaces/m/marketplace.json",
  "settings.json",
  "shell-snapshots/s.sh",
  "skills/personal/notes.txt",
  "todos/t.json",
];

function write(path: string, body = path) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

function listFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)))
    .toSorted();
}

function setup() {
  const root = tempDirs.make("pull-factory-transcripts-");
  const claude = join(root, "claude");
  for (const file of [...CONTRACT_FILES, ...PRIVATE_FILES, "projects/a.jsonl"]) {
    write(join(claude, file));
  }
  write(join(root, "checkout/linked/SKILL.md"));
  symlinkSync(join(root, "checkout/linked"), join(claude, "skills/linked"));
  const archive = join(root, "archive");
  write(join(archive, "n1/projects/x.jsonl"));
  // Stands in for the sudoers rule: run the rsync sender as ourselves.
  write(join(root, "bin/sudo"), '#!/bin/sh\n[ "$1" = -n ] && shift\nshift 2\nexec "$@"\n');
  chmodSync(join(root, "bin/sudo"), 0o755);
  write(join(root, "satellites.conf"), `n1 local-systemd ${userInfo().username}\n`);

  const pull = (...args: string[]) => {
    const result = spawnSync(SCRIPT, args, {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${join(root, "bin")}:${process.env.PATH}`,
        OPENCLAW_SATELLITES_FILE: join(root, "satellites.conf"),
        FACTORY_TRANSCRIPTS_DIR: archive,
        FACTORY_TRANSCRIPTS_LOG: join(root, "pull.log"),
        FACTORY_CLAUDE_DIR: claude,
      },
    });
    expect(result.status, readFileSync(join(root, "pull.log"), "utf8")).toBe(0);
  };
  return { claude, node: join(archive, "n1"), pull };
}

describe.skipIf(process.platform !== "linux")("pull-factory-transcripts.sh skill mirror", () => {
  it("copies only skill metadata next to projects and stamps the pull", () => {
    const { node, pull } = setup();
    pull();

    expect(listFiles(node)).toEqual(
      [
        ...CONTRACT_FILES,
        "projects/a.jsonl",
        "projects/x.jsonl",
        "skills-pulled-at",
        "skills/linked/SKILL.md",
      ].toSorted(),
    );
    expect(readFileSync(join(node, "skills-pulled-at"), "utf8")).toMatch(
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\n$/,
    );
    expect(statSync(node).mode & 0o777).toBe(0o700);
    expect(statSync(join(node, "skills/personal/SKILL.md")).mode & 0o777).toBe(0o600);
  });

  it("drops a removed skill or plugin version but keeps archived transcripts", () => {
    const { claude, node, pull } = setup();
    pull();
    rmSync(join(claude, "skills/personal"), { recursive: true });
    rmSync(join(claude, "plugins/cache/m/p/0.9"), { recursive: true });
    rmSync(join(claude, "projects/a.jsonl"));
    pull();

    expect(existsSync(join(node, "skills/personal"))).toBe(false);
    expect(existsSync(join(node, "plugins/cache/m/p/0.9"))).toBe(false);
    expect(existsSync(join(node, "skills/cat/nested/SKILL.md"))).toBe(true);
    expect(listFiles(join(node, "projects"))).toEqual(["a.jsonl", "x.jsonl"]);
  });

  it("writes neither skills nor a stamp on --dry-run", () => {
    const { node, pull } = setup();
    pull("--dry-run");

    expect(listFiles(node)).toEqual(["projects/x.jsonl"]);
  });
});
