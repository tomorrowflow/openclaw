import type { WorkboardBoardLink, WorkboardBoardSecret } from "@openclaw/workboard-contract";
import { isValidSecretRef } from "openclaw/plugin-sdk/secret-input";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeBoundedString } from "./store-value-normalizers.js";

const MAX_BOARD_ENTRIES = 20;
const MAX_LABEL_CHARS = 60;
const MAX_GROUP_CHARS = 40;
const MAX_URL_CHARS = 2000;

function normalizeLabelAndGroup<Own extends object>(
  entry: Record<string, unknown>,
  field: string,
  own: Own,
) {
  const label = normalizeBoundedString(entry.label, undefined, MAX_LABEL_CHARS, `${field} label`);
  if (!label) {
    throw new Error(`${field} needs a label of 1 to ${MAX_LABEL_CHARS} characters.`);
  }
  const group = normalizeBoundedString(entry.group, undefined, MAX_GROUP_CHARS, `${field} group`);
  return { label, ...own, ...(group ? { group } : {}) };
}

function readEntries(value: unknown, field: string): Record<string, unknown>[] | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || !value.every(isRecord)) {
    throw new Error(`${field} must be a list of objects, or null to remove it.`);
  }
  if (value.length > MAX_BOARD_ENTRIES) {
    throw new Error(`${field} takes at most ${MAX_BOARD_ENTRIES} entries.`);
  }
  return value.length > 0 ? value : undefined;
}

/** `links: null` or an empty list removes them. Only http(s) URLs: the operator clicks them. */
export function normalizeBoardLinks(value: unknown): WorkboardBoardLink[] | undefined {
  return readEntries(value, "links")?.map((entry) => {
    const url = typeof entry.url === "string" ? entry.url.trim() : "";
    let protocol: string | undefined;
    try {
      protocol = new URL(url).protocol;
    } catch {
      // Reported below with every other invalid shape.
    }
    if (url.length > MAX_URL_CHARS || (protocol !== "https:" && protocol !== "http:")) {
      throw new Error(
        `link url must be an http or https URL of at most ${MAX_URL_CHARS} characters.`,
      );
    }
    return normalizeLabelAndGroup(entry, "link", { url });
  });
}

/** `secrets: null` or an empty list removes them. `name` follows the secrets store's own entry-name rule. */
export function normalizeBoardSecrets(value: unknown): WorkboardBoardSecret[] | undefined {
  const names = new Set<string>();
  return readEntries(value, "secrets")?.map((entry) => {
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    // The entry-name rule does not depend on the provider alias; "default" only satisfies the alias grammar.
    if (!isValidSecretRef({ source: "store", provider: "default", id: name })) {
      throw new Error(
        `secret name ${JSON.stringify(name.slice(0, 64))} must be a secrets-store entry name such as LINDRA_TEST_TOKEN.`,
      );
    }
    if (names.has(name)) {
      throw new Error(`secrets lists ${name} twice.`);
    }
    names.add(name);
    return normalizeLabelAndGroup(entry, "secret", { name });
  });
}

/** Whether a save changes the revealable-secret list, which only an admin may do. */
export function changesBoardSecrets(
  before: { secrets?: WorkboardBoardSecret[] } | undefined,
  after: { secrets?: WorkboardBoardSecret[] } | undefined,
): boolean {
  return JSON.stringify(before?.secrets ?? []) !== JSON.stringify(after?.secrets ?? []);
}
