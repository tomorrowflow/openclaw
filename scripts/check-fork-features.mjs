#!/usr/bin/env node
// Verifies every entry in docs/fork-features.txt is still present in the tree.
//
// Upstream refactors move code between files, and a rebase that takes upstream's
// copy of a file drops the fork's additions silently. This is the gate that turns
// that silence into a failure: it runs after a sync rebase and again before a
// deploy, so a fork feature can never reach main or the live Gateway missing.
//
// Entry format, one per line: pattern | file | description
// The pattern is an ERE matched against the file's contents.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Entries were written for grep -E, which accepts POSIX bracket expressions that
// JavaScript's RegExp does not. Translate the classes in use so an existing entry
// keeps meaning what its author wrote.
const POSIX_CLASSES = {
  "[:alnum:]": "A-Za-z0-9",
  "[:alpha:]": "A-Za-z",
  "[:blank:]": " \\t",
  "[:digit:]": "0-9",
  "[:lower:]": "a-z",
  "[:space:]": "\\s",
  "[:upper:]": "A-Z",
};

function toJsPattern(pattern) {
  return pattern.replace(/\[:[a-z]+:\]/g, (match) => {
    const replacement = POSIX_CLASSES[match];
    if (!replacement) {
      throw new Error(`unsupported POSIX class ${match}`);
    }
    return replacement;
  });
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const registryPath = path.join(repoRoot, "docs/fork-features.txt");

function parseEntries(text) {
  const entries = [];
  text.split("\n").forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      return;
    }
    const [pattern, file, ...rest] = line.split("|");
    if (pattern === undefined || file === undefined) {
      throw new Error(
        `docs/fork-features.txt:${index + 1}: expected "pattern | file | description"`,
      );
    }
    entries.push({
      line: index + 1,
      pattern: pattern.trim(),
      file: file.trim(),
      description: rest.join("|").trim(),
    });
  });
  return entries;
}

const entries = parseEntries(readFileSync(registryPath, "utf8"));
const missing = [];
for (const entry of entries) {
  let contents;
  try {
    contents = readFileSync(path.join(repoRoot, entry.file), "utf8");
  } catch {
    missing.push({ ...entry, reason: "file not found" });
    continue;
  }
  let matched;
  try {
    matched = new RegExp(toJsPattern(entry.pattern)).test(contents);
  } catch (error) {
    missing.push({ ...entry, reason: `invalid pattern (${error.message})` });
    continue;
  }
  if (!matched) {
    missing.push({ ...entry, reason: "pattern not found" });
  }
}

if (missing.length === 0) {
  console.log(`fork features: ${entries.length} present`);
  process.exit(0);
}

console.error(`fork features: ${missing.length} of ${entries.length} MISSING`);
for (const entry of missing) {
  console.error(`\n  docs/fork-features.txt:${entry.line} — ${entry.reason}`);
  console.error(`    pattern: ${entry.pattern}`);
  console.error(`    file:    ${entry.file}`);
  console.error(`    why:     ${entry.description}`);
}
console.error(
  "\nAn upstream refactor moved the surrounding code and the fork's addition was lost.",
);
console.error("Re-add it in the new location, then update docs/fork-features.txt to match.");
process.exit(1);
