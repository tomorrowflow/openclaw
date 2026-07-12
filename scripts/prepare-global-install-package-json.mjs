#!/usr/bin/env node
/**
 * Fork-only: make the root `package.json` installable with `npm i -g .`.
 *
 * Why this exists:
 * Upstream ships internal packages as `workspace:*` runtime dependencies of the
 * `openclaw` package (currently `@openclaw/ai`; the set grows as upstream splits
 * the monorepo). On publish, pnpm rewrites `workspace:*` to the real published
 * version and npm pulls each package from the registry. This fork installs from
 * source (`npm i -g . --install-links`) and does not publish those packages, so
 * npm hits `EUNSUPPORTEDPROTOCOL Unsupported URL Type "workspace:"` and aborts.
 *
 * This script rewrites every root `dependencies` entry whose spec uses the
 * `workspace:` protocol and whose name resolves to a local workspace package
 * into an absolute `file:` path. With `--install-links`, npm copies the built
 * package (and hoists its real npm deps) into the global install, so the runtime
 * `import "@openclaw/ai"` resolves. Only `dependencies` are touched — devDeps
 * keep their `workspace:*` refs (npm i -g omits them; deploy-globally.mjs strips
 * them from copied extension manifests separately).
 *
 * Usage:
 *   node scripts/prepare-global-install-package-json.mjs            # rewrite (backs up)
 *   node scripts/prepare-global-install-package-json.mjs --restore  # restore backup
 *
 * The rewrite is only meant to bracket a single `npm i -g .`; always restore
 * afterwards so the committed `workspace:*` form is never left on disk.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PKG_PATH = path.join(REPO_ROOT, "package.json");
const BACKUP_PATH = path.join(REPO_ROOT, "package.json.workspace-deps-bak");

// Workspace roots that can back a `workspace:` root dependency. Root deps only
// reference internal packages today, but scan the same globs pnpm-workspace.yaml
// declares so a future externalized package under any of them is handled.
const WORKSPACE_GLOBS = ["packages", "extensions", "ui", "packages/markdown-core"];

function log(msg) {
  process.stdout.write(`[prepare-global-install] ${msg}\n`);
}

function buildLocalPackageIndex() {
  const index = new Map();
  const candidateDirs = new Set([REPO_ROOT]);
  for (const glob of WORKSPACE_GLOBS) {
    const base = path.join(REPO_ROOT, glob);
    if (!fs.existsSync(base)) {
      continue;
    }
    const stat = fs.statSync(base);
    if (fs.existsSync(path.join(base, "package.json"))) {
      candidateDirs.add(base);
    }
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          candidateDirs.add(path.join(base, entry.name));
        }
      }
    }
  }
  for (const dir of candidateDirs) {
    const pj = path.join(dir, "package.json");
    if (!fs.existsSync(pj)) {
      continue;
    }
    try {
      const name = JSON.parse(fs.readFileSync(pj, "utf8")).name;
      if (typeof name === "string" && name && !index.has(name)) {
        index.set(name, dir);
      }
    } catch {
      // ignore unreadable/partial package.json files
    }
  }
  return index;
}

function restore() {
  if (!fs.existsSync(BACKUP_PATH)) {
    log("no backup found — nothing to restore");
    return;
  }
  fs.copyFileSync(BACKUP_PATH, PKG_PATH);
  fs.rmSync(BACKUP_PATH);
  log("restored package.json from backup");
}

function rewrite() {
  const raw = fs.readFileSync(PKG_PATH, "utf8");
  const pkg = JSON.parse(raw);
  const deps = pkg.dependencies ?? {};
  const localPackages = buildLocalPackageIndex();
  const rewritten = [];
  const unresolved = [];
  for (const [name, spec] of Object.entries(deps)) {
    if (typeof spec !== "string" || !spec.startsWith("workspace:")) {
      continue;
    }
    const dir = localPackages.get(name);
    if (!dir) {
      unresolved.push(name);
      continue;
    }
    deps[name] = `file:${dir}`;
    rewritten.push(`${name} -> file:${path.relative(REPO_ROOT, dir)}`);
  }
  if (unresolved.length > 0) {
    // A workspace: dep that maps to no local package would still break the
    // install; fail loudly rather than silently leaving it for npm to reject.
    throw new Error(
      `unresolved workspace dependencies (no local package found): ${unresolved.join(", ")}`,
    );
  }
  if (rewritten.length === 0) {
    log("no workspace: runtime dependencies to rewrite");
    return;
  }
  // Preserve trailing newline convention of the original file.
  fs.copyFileSync(PKG_PATH, BACKUP_PATH);
  const trailing = raw.endsWith("\n") ? "\n" : "";
  fs.writeFileSync(PKG_PATH, `${JSON.stringify(pkg, null, 2)}${trailing}`);
  log(`rewrote ${rewritten.length} workspace dependency(ies): ${rewritten.join(", ")}`);
}

if (process.argv.includes("--restore")) {
  restore();
} else {
  rewrite();
}
