import type { WorkboardBoardLink, WorkboardBoardSecret } from "@openclaw/workboard-contract";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { WorkboardBoardSummary } from "./types.ts";

type BoardInfoSettings = Pick<
  NonNullable<WorkboardBoardSummary["orchestration"]>,
  "links" | "secrets" | "env" | "previewEnv"
>;

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function entries<T>(value: unknown, read: (entry: Record<string, unknown>) => T | undefined): T[] {
  return (Array.isArray(value) ? value : []).flatMap((entry) => {
    const item = isRecord(entry) ? read(entry) : undefined;
    return item ? [item] : [];
  });
}

function readLink(entry: Record<string, unknown>): WorkboardBoardLink | undefined {
  const label = text(entry.label);
  const url = text(entry.url);
  const group = text(entry.group);
  return label && url ? { label, url, ...(group ? { group } : {}) } : undefined;
}

function readSecret(entry: Record<string, unknown>): WorkboardBoardSecret | undefined {
  const label = text(entry.label);
  const name = text(entry.name);
  const group = text(entry.group);
  return label && name ? { label, name, ...(group ? { group } : {}) } : undefined;
}

/** Preview env var name -> store entry id; an entry that names no store secret is skipped. */
function readPreviewEnv(value: unknown): Record<string, string> {
  const env = isRecord(value) && isRecord(value.env) ? value.env : {};
  return Object.fromEntries(
    Object.entries(env).flatMap(([name, ref]) => {
      const id = isRecord(ref) ? text(ref.id) : undefined;
      return id ? [[name, id]] : [];
    }),
  );
}

/**
 * What the board info popover lists: links, revealable secret names, the
 * board's plain env, and the env names of its preview secrets. The Gateway already
 * validated them; this keeps only shapes the popover can render.
 */
export function normalizeBoardInfo(value: Record<string, unknown>): BoardInfoSettings {
  const links = entries(value.links, readLink);
  const secrets = entries(value.secrets, readSecret);
  const env = isRecord(value.env)
    ? Object.fromEntries(
        Object.entries(value.env).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      )
    : {};
  const previewEnv = readPreviewEnv(value.preview);
  return {
    ...(links.length ? { links } : {}),
    ...(secrets.length ? { secrets } : {}),
    ...(Object.keys(env).length ? { env } : {}),
    ...(Object.keys(previewEnv).length ? { previewEnv } : {}),
  };
}
