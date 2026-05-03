#!/usr/bin/env node
/**
 * Fork-only: deploy a freshly-built core to the system-wide global install
 * (`$(npm root -g)/openclaw/`).
 *
 * Why this exists:
 * Upstream's `package.json#files` excludes a growing set of multi-file
 * extensions (memory-lancedb, googlechat, matrix, msteams, whatsapp, …) via
 * `!dist/extensions/<id>/**`. Upstream's design is that those plugins are
 * "externalized" — installed separately via npm using each plugin's
 * `openclaw.install.npmSpec`. This fork runs as a single-host gateway and
 * wants those plugins bundled into the same global install. So after
 * `npm i -g . --install-links`, this script:
 *
 *   1. Discovers every extension excluded by `package.json#files` whose
 *      local `dist/extensions/<id>/` was actually built (i.e. the user
 *      passed OPENCLAW_INCLUDE_OPTIONAL_BUNDLED=1 to the build).
 *   2. Copies each one into the global install.
 *   3. Strips `devDependencies` (which contain `workspace:*` refs that
 *      newer npm rejects even with `--omit=dev`) and runs
 *      `npm install --omit=dev --ignore-scripts` so each extension's
 *      runtime deps land in its own `node_modules/`.
 *   4. Copies library-only extensions (speech-core, image-generation-core,
 *      media-understanding-core) that have no `openclaw.plugin.json` and
 *      so are skipped by the build pipeline but resolved at runtime via
 *      jiti from `dist/extensions/<name>/runtime-api.ts`.
 *   5. Reinstalls supergateway (which `npm i -g .` can drop because it
 *      shares the global prefix).
 *   6. Builds + copies the Control UI (not part of `pnpm build`).
 *
 * The script is idempotent: re-running it overwrites the targets.
 *
 * It does NOT run `pnpm build` or `npm i -g .` — those happen first in the
 * deploy lane (see docs/UPSTREAM-SYNC.md step 8).
 *
 * Usage:
 *   node scripts/deploy-globally.mjs
 *
 * Requires sudo (the global install is root-owned). The script will call
 * `sudo` itself for write operations.
 */

import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Library-only extensions: no openclaw.plugin.json, resolved at runtime via
// jiti at dist/extensions/<name>/runtime-api.ts. The build pipeline skips
// them entirely so we copy the TS sources here.
const LIBRARY_EXTENSIONS = ["image-generation-core", "media-understanding-core", "speech-core"];

function log(msg) {
  process.stdout.write(`[deploy-globally] ${msg}\n`);
}

function sh(cmd, opts = {}) {
  return execSync(cmd, { stdio: opts.silent ? "pipe" : "inherit", encoding: "utf8", ...opts });
}

function readPackageJson(packageRoot) {
  return JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
}

// Names that look like extension exclusions but are actually paths to
// shared dependency dirs / non-plugin artifacts. Skip them so we don't try
// to "bundle" something that isn't a plugin.
const NON_PLUGIN_EXCLUDED_NAMES = new Set(["node_modules"]);

function collectExcludedExtensionDirs(packageJson) {
  const excluded = new Set();
  const files = packageJson?.files;
  if (!Array.isArray(files)) {
    return excluded;
  }
  for (const entry of files) {
    if (typeof entry !== "string") {
      continue;
    }
    const match = /^!dist\/extensions\/([^/]+)\/\*\*$/u.exec(entry);
    if (!match?.[1]) {
      continue;
    }
    if (NON_PLUGIN_EXCLUDED_NAMES.has(match[1])) {
      continue;
    }
    excluded.add(match[1]);
  }
  return excluded;
}

function npmGlobalRoot() {
  return execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
}

function ensureSudo() {
  try {
    execFileSync("sudo", ["-n", "true"], { stdio: "ignore" });
  } catch {
    log("sudo credentials needed for writes to the global install");
  }
}

function copyDir(src, dest) {
  // Use sudo cp -r to handle the root-owned target, preserving ownership.
  sh(`sudo rm -rf ${JSON.stringify(dest)}`);
  sh(`sudo cp -r ${JSON.stringify(src)} ${JSON.stringify(dest)}`);
}

function stripDevDependencies(packageJsonPath) {
  // Multi-file extension package.json files keep `workspace:*` refs in
  // devDependencies (e.g. `@openclaw/plugin-sdk: workspace:*`). npm 10
  // errors out on those even with `--omit=dev`, so strip them outright.
  const tmp = `${packageJsonPath}.tmp`;
  sh(
    `sudo sh -c 'jq "del(.devDependencies)" ${JSON.stringify(packageJsonPath)} > ${JSON.stringify(tmp)} && mv ${JSON.stringify(tmp)} ${JSON.stringify(packageJsonPath)}'`,
  );
}

function npmInstallExtensionDeps(extDir) {
  const packageJsonPath = path.join(extDir, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    return;
  }
  let packageJson;
  try {
    packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  } catch {
    return;
  }
  const deps = packageJson?.dependencies;
  if (!deps || Object.keys(deps).length === 0) {
    return;
  }
  stripDevDependencies(packageJsonPath);
  // --ignore-scripts: skip lifecycle scripts in deps (e.g. lancedb postinstall
  // would re-fetch native binaries; we already bundle them via pnpm install).
  sh(`sudo npm install --omit=dev --ignore-scripts --prefix ${JSON.stringify(extDir)}`, {
    silent: true,
  });
}

function bundleExternalizedExtensions() {
  const packageJson = readPackageJson(REPO_ROOT);
  const excluded = collectExcludedExtensionDirs(packageJson);
  const localDistRoot = path.join(REPO_ROOT, "dist", "extensions");
  const globalRoot = npmGlobalRoot();
  const globalDistRoot = path.join(globalRoot, "openclaw", "dist", "extensions");

  if (!fs.existsSync(localDistRoot)) {
    throw new Error(
      `dist/extensions/ missing — run 'OPENCLAW_INCLUDE_OPTIONAL_BUNDLED=1 pnpm build' first`,
    );
  }
  if (!fs.existsSync(globalDistRoot)) {
    throw new Error(`${globalDistRoot} missing — run 'sudo npm i -g . --install-links' first`);
  }

  const restored = [];
  const skipped = [];
  for (const name of [...excluded].toSorted((left, right) => left.localeCompare(right))) {
    const localPath = path.join(localDistRoot, name);
    if (!fs.existsSync(localPath)) {
      skipped.push(name);
      continue;
    }
    const globalPath = path.join(globalDistRoot, name);
    copyDir(localPath, globalPath);
    npmInstallExtensionDeps(globalPath);
    restored.push(name);
  }
  if (restored.length > 0) {
    log(`bundled ${restored.length} externalized extensions: ${restored.join(", ")}`);
  }
  if (skipped.length > 0) {
    log(
      `skipped ${skipped.length} excluded extensions not built locally (run with OPENCLAW_INCLUDE_OPTIONAL_BUNDLED=1 if you need them): ${skipped.join(", ")}`,
    );
  }
}

function copyLibraryExtensions() {
  const localExtRoot = path.join(REPO_ROOT, "extensions");
  const globalRoot = npmGlobalRoot();
  const globalExtRoot = path.join(globalRoot, "openclaw", "dist", "extensions");
  const copied = [];
  for (const name of LIBRARY_EXTENSIONS) {
    const localPath = path.join(localExtRoot, name);
    if (!fs.existsSync(localPath)) {
      continue;
    }
    const globalPath = path.join(globalExtRoot, name);
    sh(`sudo mkdir -p ${JSON.stringify(globalPath)}`);
    // Top-level *.ts files (excluding tests and .d.ts).
    for (const entry of fs.readdirSync(localPath)) {
      if (!entry.endsWith(".ts")) {
        continue;
      }
      if (entry.includes(".test.") || entry.endsWith(".d.ts")) {
        continue;
      }
      const src = path.join(localPath, entry);
      sh(`sudo cp ${JSON.stringify(src)} ${JSON.stringify(globalPath)}/`);
    }
    // Nested src/ tree (if any).
    const localSrc = path.join(localPath, "src");
    if (fs.existsSync(localSrc)) {
      sh(`sudo cp -r ${JSON.stringify(localSrc)} ${JSON.stringify(globalPath)}/`);
    }
    copied.push(name);
  }
  if (copied.length > 0) {
    log(`copied ${copied.length} library extension sources: ${copied.join(", ")}`);
  }
}

function reinstallSupergateway() {
  // `npm i -g .` can drop unrelated globals because they share /usr/lib/node_modules.
  // supergateway bridges external HTTP MCP servers (dav, planka, lightrag) to stdio.
  try {
    sh(`sudo npm i -g supergateway`, { silent: true });
    log("supergateway reinstalled");
  } catch (err) {
    log(`WARN: supergateway reinstall failed: ${err?.message ?? err}`);
  }
}

function rebuildAndCopyControlUi() {
  // pnpm build does NOT include the Control UI; it must be rebuilt + copied
  // every time the global dist/ is replaced.
  sh(`pnpm ui:build`);
  const globalRoot = npmGlobalRoot();
  const globalUiDir = path.join(globalRoot, "openclaw", "dist", "control-ui");
  const localUiDir = path.join(REPO_ROOT, "dist", "control-ui");
  if (!fs.existsSync(localUiDir)) {
    throw new Error(`UI build output missing at ${localUiDir}`);
  }
  sh(`sudo rm -rf ${JSON.stringify(globalUiDir)}`);
  sh(`sudo cp -r ${JSON.stringify(localUiDir)} ${JSON.stringify(globalUiDir)}`);
  log("Control UI rebuilt and copied");
}

function verifyDeploy() {
  const globalRoot = npmGlobalRoot();
  const indexHtml = path.join(globalRoot, "openclaw", "dist", "control-ui", "index.html");
  if (!fs.existsSync(indexHtml)) {
    throw new Error(`Control UI index.html missing at ${indexHtml}`);
  }
  log("verified Control UI index.html present");
}

function main() {
  ensureSudo();
  bundleExternalizedExtensions();
  copyLibraryExtensions();
  reinstallSupergateway();
  rebuildAndCopyControlUi();
  verifyDeploy();
  log("deploy-globally complete");
}

main();
