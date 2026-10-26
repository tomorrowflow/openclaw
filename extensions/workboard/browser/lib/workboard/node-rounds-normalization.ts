import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type {
  WorkboardNodeChangedFile,
  WorkboardNodeChanges,
  WorkboardNodeDecision,
  WorkboardNodeRound,
  WorkboardRoundReviewTimes,
} from "./types.ts";

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function normalizeDecision(value: unknown): WorkboardNodeDecision[] {
  if (!isRecord(value)) {
    return [];
  }
  const phase = text(value.phase);
  const decision = text(value.decision);
  if (!phase || !decision) {
    return [];
  }
  const ts = text(value.ts);
  const why = text(value.why);
  const evidence = text(value.evidence);
  const result = text(value.result);
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
}

function normalizeFile(value: unknown): WorkboardNodeChangedFile[] {
  if (!isRecord(value)) {
    return [];
  }
  const path = text(value.path);
  if (!path) {
    return [];
  }
  const previousPath = text(value.previousPath);
  const named = previousPath ? { path, previousPath } : { path };
  if (value.binary === true) {
    return [{ ...named, binary: true }];
  }
  const added = count(value.added);
  const deleted = count(value.deleted);
  return added === undefined || deleted === undefined ? [] : [{ ...named, added, deleted }];
}

function normalizeChanges(value: unknown): WorkboardNodeChanges | undefined {
  if (!isRecord(value) || !isRecord(value.totals)) {
    return undefined;
  }
  const from = text(value.from);
  const to = text(value.to);
  const files = count(value.totals.files);
  const added = count(value.totals.added);
  const deleted = count(value.totals.deleted);
  return from && to && files !== undefined && added !== undefined && deleted !== undefined
    ? {
        from,
        to,
        files: Array.isArray(value.files) ? value.files.flatMap(normalizeFile) : [],
        totals: { files, added, deleted },
      }
    : undefined;
}

/** A node ticket's round facts as the Gateway sends them beside the card; the UI keeps what it can render. */
export function normalizeNodeRounds(value: unknown): WorkboardNodeRound[] {
  return (Array.isArray(value) ? value : []).flatMap((entry): WorkboardNodeRound[] => {
    const round = isRecord(entry) ? count(entry.round) : undefined;
    if (!isRecord(entry) || round === undefined) {
      return [];
    }
    const decisions = Array.isArray(entry.decisions)
      ? entry.decisions.flatMap(normalizeDecision)
      : [];
    const changes = normalizeChanges(entry.changes);
    return decisions.length > 0 || changes
      ? [{ round, ...(decisions.length > 0 ? { decisions } : {}), ...(changes ? { changes } : {}) }]
      : [];
  });
}

/** The Gateway derives review times; rounds without an import time are dropped. */
export function normalizeReviewTimes(value: unknown): WorkboardRoundReviewTimes[] {
  return (Array.isArray(value) ? value : []).flatMap((entry): WorkboardRoundReviewTimes[] => {
    const round = isRecord(entry) ? count(entry.round) : undefined;
    const importedAt = isRecord(entry) ? count(entry.importedAt) : undefined;
    if (round === undefined || importedAt === undefined) {
      return [];
    }
    const verdictAt = count(entry.verdictAt);
    const startedAt = isRecord(entry.verification)
      ? count(entry.verification.startedAt)
      : undefined;
    const endedAt = isRecord(entry.verification) ? count(entry.verification.endedAt) : undefined;
    return [
      {
        round,
        importedAt,
        ...(startedAt === undefined
          ? {}
          : { verification: { startedAt, ...(endedAt === undefined ? {} : { endedAt }) } }),
        ...(verdictAt === undefined ? {} : { verdictAt }),
      },
    ];
  });
}
