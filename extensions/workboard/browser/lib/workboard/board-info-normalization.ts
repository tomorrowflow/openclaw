import type {
  WorkboardBoardLink,
  WorkboardBoardSecret,
  WorkboardOrchestrationSettings,
  WorkboardPreviewSecretRef,
  WorkboardPreviewSettings,
} from "@openclaw/workboard-contract";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

type BoardInfoSettings = Pick<
  WorkboardOrchestrationSettings,
  "links" | "secrets" | "env" | "preview"
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

function readStrings(value: unknown): string[] {
  return (Array.isArray(value) ? value : []).filter((entry) => typeof entry === "string");
}

function readPreview(value: unknown): WorkboardPreviewSettings | undefined {
  if (!isRecord(value) || !isRecord(value.ports) || !isRecord(value.env)) {
    return undefined;
  }
  const env: Record<string, WorkboardPreviewSecretRef> = {};
  for (const [name, ref] of Object.entries(value.env)) {
    const provider = isRecord(ref) ? text(ref.provider) : undefined;
    const id = isRecord(ref) ? text(ref.id) : undefined;
    if (provider && id) {
      env[name] = { source: "store", provider, id };
    }
  }
  const { from, to } = value.ports;
  return Object.keys(env).length && typeof from === "number" && typeof to === "number"
    ? { up: readStrings(value.up), down: readStrings(value.down), ports: { from, to }, env }
    : undefined;
}

/**
 * What the board info popover lists: links, revealable secret names, the
 * board's plain env, and the names of its preview secrets. The Gateway already
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
  const preview = readPreview(value.preview);
  return {
    ...(links.length ? { links } : {}),
    ...(secrets.length ? { secrets } : {}),
    ...(Object.keys(env).length ? { env } : {}),
    ...(preview ? { preview } : {}),
  };
}
