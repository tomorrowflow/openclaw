import type {
  WorkboardNodeChangedFile,
  WorkboardNodeChanges,
  WorkboardNodeDecision,
  WorkboardNodeFinding,
  WorkboardNodeReview,
  WorkboardNodeRound,
  WorkboardNodeWorktree,
} from "@openclaw/workboard-contract";
import {
  parseStrictPositiveInteger,
  resolveOptionalIntegerOption,
} from "openclaw/plugin-sdk/number-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";

// Round facts ride in the card's metadata, which has a 24 KiB budget shared
// with comments and proof. A full round serializes to about 6 KiB; the budget
// trim drops rounds before anything else.
const MAX_NODE_ROUNDS = 5;
const MAX_DECISIONS = 30;
const MAX_DECISION_TRAIL_CHARS = 3000;
const MAX_CHANGED_FILES = 30;
const MAX_CHANGED_PATH_CHARS = 1500;
const MAX_PATH_CHARS = 200;
const DECISION_CELL_CHARS = {
  ts: 32,
  phase: 24,
  decision: 160,
  why: 200,
  evidence: 160,
  result: 120,
} as const;
const MAX_FINDINGS = 12;
const MAX_FINDINGS_CHARS = 2400;
// Findings are traced to edits by path and line, so a longer path is dropped, not cut.
const MAX_FINDING_PATH_CHARS = 160;
const FINDING_CELL_CHARS = { body: 200, rule: 80 } as const;
const MAX_REVIEW_NOTE_CHARS = 400;

function cell(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const line = value.replace(/\s+/g, " ").trim();
  if (!line) {
    return undefined;
  }
  return line.length <= max ? line : `${truncateUtf16Safe(line, max - 1)}…`;
}

/** Paths keep their exact characters; only the length is capped. */
function capPath(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) {
    return undefined;
  }
  return value.length <= MAX_PATH_CHARS
    ? value
    : `${truncateUtf16Safe(value, MAX_PATH_CHARS - 1)}…`;
}

function decisionChars(decision: WorkboardNodeDecision): number {
  return Object.values(decision).reduce((total, value) => total + value.length, 0);
}

/** Keeps the newest rows that fit the trail's row and character caps. */
function capTrail(decisions: readonly WorkboardNodeDecision[]): WorkboardNodeDecision[] {
  const kept: WorkboardNodeDecision[] = [];
  let chars = 0;
  for (const decision of decisions.toReversed()) {
    chars += decisionChars(decision);
    if (kept.length === MAX_DECISIONS || chars > MAX_DECISION_TRAIL_CHARS) {
      break;
    }
    kept.push(decision);
  }
  return kept.toReversed();
}

/** Session-written decision rows; a row without a phase and a decision is dropped. */
export function normalizeNodeDecisions(value: unknown): WorkboardNodeDecision[] {
  const rows = (Array.isArray(value) ? value : []).flatMap((entry): WorkboardNodeDecision[] => {
    if (!isRecord(entry)) {
      return [];
    }
    const phase = cell(entry.phase, DECISION_CELL_CHARS.phase);
    const decision = cell(entry.decision, DECISION_CELL_CHARS.decision);
    if (!phase || !decision) {
      return [];
    }
    const ts = cell(entry.ts, DECISION_CELL_CHARS.ts);
    const why = cell(entry.why, DECISION_CELL_CHARS.why);
    const evidence = cell(entry.evidence, DECISION_CELL_CHARS.evidence);
    const result = cell(entry.result, DECISION_CELL_CHARS.result);
    return [
      {
        ...(ts ? { ts } : {}),
        phase,
        decision,
        ...(why ? { why } : {}),
        ...(evidence ? { evidence } : {}),
        ...(result ? { result } : {}),
      },
    ];
  });
  return capTrail(rows);
}

function churn(file: WorkboardNodeChangedFile): number {
  return "binary" in file ? -1 : file.added + file.deleted;
}

/** Keeps the files with the most changed lines that fit the count and path caps. */
function capFiles(files: readonly WorkboardNodeChangedFile[]): WorkboardNodeChangedFile[] {
  const kept: WorkboardNodeChangedFile[] = [];
  let chars = 0;
  for (const file of files.toSorted((left, right) => churn(right) - churn(left))) {
    chars += file.path.length + (file.previousPath?.length ?? 0);
    if (kept.length === MAX_CHANGED_FILES || chars > MAX_CHANGED_PATH_CHARS) {
      break;
    }
    kept.push(file);
  }
  return kept;
}

type Lines = { added: number; deleted: number };

function changedFile(
  path: unknown,
  previousPath: unknown,
  counts: Lines | "binary" | undefined,
): WorkboardNodeChangedFile | undefined {
  const kept = capPath(path);
  if (!kept || !counts) {
    return undefined;
  }
  const previous = capPath(previousPath);
  const renamed = previous ? { path: kept, previousPath: previous } : { path: kept };
  return counts === "binary" ? { ...renamed, binary: true } : { ...renamed, ...counts };
}

function count(value: unknown): number | undefined {
  return resolveOptionalIntegerOption(value, { min: 0 });
}

function lineCounts(added: unknown, deleted: unknown): Lines | undefined {
  const lines = { added: count(added), deleted: count(deleted) };
  return lines.added === undefined || lines.deleted === undefined
    ? undefined
    : { added: lines.added, deleted: lines.deleted };
}

/**
 * Reads `git diff --numstat -z` output: `added<TAB>deleted<TAB>path<NUL>`,
 * or for a rename an empty path followed by `old<NUL>new<NUL>`; binary files
 * count `-` lines.
 */
export function parseNumstat(output: string, from: string, to: string): WorkboardNodeChanges {
  const tokens = output.split("\0");
  const files: WorkboardNodeChangedFile[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    // A path may itself contain tabs, so only the first two separate fields.
    const fields = /^([^\t]*)\t([^\t]*)\t(.*)$/s.exec(tokens[index] ?? "");
    if (!fields) {
      continue;
    }
    const [, added = "", deleted = "", path = ""] = fields;
    const counts =
      added === "-" && deleted === "-" ? "binary" : lineCounts(Number(added), Number(deleted));
    const file = path
      ? changedFile(path, undefined, counts)
      : changedFile(tokens[index + 2], tokens[index + 1], counts);
    if (!path) {
      index += 2;
    }
    if (file) {
      files.push(file);
    }
  }
  const totals = { files: files.length, added: 0, deleted: 0 };
  for (const file of files) {
    if (!("binary" in file)) {
      totals.added += file.added;
      totals.deleted += file.deleted;
    }
  }
  return { from, to, files: capFiles(files), totals };
}

function normalizeFinding(entry: unknown): WorkboardNodeFinding | undefined {
  if (!isRecord(entry)) {
    return undefined;
  }
  const path = typeof entry.path === "string" ? entry.path.trim() : "";
  const line = parseStrictPositiveInteger(entry.line);
  const body = cell(entry.body, FINDING_CELL_CHARS.body);
  if (!path || path.length > MAX_FINDING_PATH_CHARS || line === undefined || !body) {
    return undefined;
  }
  const rule = cell(entry.rule, FINDING_CELL_CHARS.rule);
  return { path, line, body, ...(rule ? { rule } : {}), fixed: entry.fixed === true };
}

/** Session-written findings; one without a path, a 1-based line, or a body is dropped. */
export function normalizeNodeFindings(value: unknown): WorkboardNodeFinding[] {
  return (Array.isArray(value) ? value : []).flatMap((entry) => {
    const finding = normalizeFinding(entry);
    return finding ? [finding] : [];
  });
}

/** Keeps open findings first, within the count and character caps. */
function capFindings(findings: readonly WorkboardNodeFinding[]): WorkboardNodeFinding[] {
  const kept: WorkboardNodeFinding[] = [];
  let chars = 0;
  for (const finding of findings.toSorted(
    (left, right) => Number(left.fixed) - Number(right.fixed),
  )) {
    chars += finding.path.length + finding.body.length + (finding.rule?.length ?? 0);
    if (kept.length === MAX_FINDINGS || chars > MAX_FINDINGS_CHARS) {
      break;
    }
    kept.push(finding);
  }
  return kept;
}

/** A recorded standards review: the counts are required, `items` is capped. */
export function normalizeNodeReview(value: unknown): WorkboardNodeReview | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const findings = count(value.findings);
  const fixed = count(value.fixed);
  if (findings === undefined || fixed === undefined) {
    return undefined;
  }
  const note = cell(value.note, MAX_REVIEW_NOTE_CHARS);
  const items = capFindings(normalizeNodeFindings(value.items));
  return {
    findings,
    fixed,
    ...(note ? { note } : {}),
    ...(items.length > 0 ? { items } : {}),
  };
}

function normalizeChanges(value: unknown): WorkboardNodeChanges | undefined {
  if (!isRecord(value) || !isRecord(value.totals)) {
    return undefined;
  }
  const from = cell(value.from, 64);
  const to = cell(value.to, 64);
  const files = count(value.totals.files);
  const lines = lineCounts(value.totals.added, value.totals.deleted);
  if (!from || !to || files === undefined || !lines) {
    return undefined;
  }
  const kept = (Array.isArray(value.files) ? value.files : []).flatMap(
    (entry): WorkboardNodeChangedFile[] => {
      const file = isRecord(entry)
        ? changedFile(
            entry.path,
            entry.previousPath,
            entry.binary === true ? "binary" : lineCounts(entry.added, entry.deleted),
          )
        : undefined;
      return file ? [file] : [];
    },
  );
  return { from, to, files: capFiles(kept), totals: { files, ...lines } };
}

/** Recorded rounds as stored; malformed entries are dropped. */
export function normalizeNodeRounds(value: unknown): WorkboardNodeRound[] {
  return (Array.isArray(value) ? value : [])
    .flatMap((entry): WorkboardNodeRound[] => {
      const round = isRecord(entry) ? count(entry.round) : undefined;
      if (!isRecord(entry) || round === undefined) {
        return [];
      }
      const decisions = normalizeNodeDecisions(entry.decisions);
      const changes = normalizeChanges(entry.changes);
      const review = normalizeNodeReview(entry.review);
      return [
        {
          round,
          ...(decisions.length > 0 ? { decisions } : {}),
          ...(changes ? { changes } : {}),
          ...(review ? { review } : {}),
        },
      ];
    })
    .slice(-MAX_NODE_ROUNDS);
}

export type WorkboardNodeRoundFacts = {
  decisions?: readonly WorkboardNodeDecision[];
  changes?: WorkboardNodeChanges;
  review?: WorkboardNodeReview;
};

/**
 * Adds facts to the worktree's current round: a report's decisions append to
 * the round's trail, its review and an import's changes replace the round's
 * earlier ones.
 */
export function withNodeRound(
  worktree: WorkboardNodeWorktree,
  facts: WorkboardNodeRoundFacts,
): WorkboardNodeWorktree {
  const round = worktree.rework?.round ?? 0;
  const rounds = worktree.rounds ?? [];
  const current = rounds.find((entry) => entry.round === round);
  const decisions = capTrail([...(current?.decisions ?? []), ...(facts.decisions ?? [])]);
  const changes = facts.changes ?? current?.changes;
  const review = facts.review ?? current?.review;
  const next: WorkboardNodeRound = {
    round,
    ...(decisions.length > 0 ? { decisions } : {}),
    ...(changes ? { changes } : {}),
    ...(review ? { review } : {}),
  };
  return {
    ...worktree,
    rounds: [...rounds.filter((entry) => entry.round !== round), next]
      .toSorted((left, right) => left.round - right.round)
      .slice(-MAX_NODE_ROUNDS),
  };
}
