const MAX_HELD_PATHS = 100;
const MAX_HELD_PATH_CHARS = 200;

/**
 * A board's `heldPaths` as stored: repo-relative, `./` segments and doubled
 * slashes folded, duplicates dropped, and a trailing `/` kept to hold the
 * directory alone. `null` clears the list.
 */
export function normalizeHeldPaths(value: unknown): string[] {
  if (value === null) {
    return [];
  }
  if (!Array.isArray(value) || value.length > MAX_HELD_PATHS) {
    throw new Error(`heldPaths must be an array of at most ${MAX_HELD_PATHS} repo-relative paths.`);
  }
  const paths: string[] = [];
  for (const entry of value) {
    const path = normalizeHeldPath(entry);
    if (!paths.includes(path)) {
      paths.push(path);
    }
  }
  return paths;
}

function normalizeHeldPath(entry: unknown): string {
  const trimmed = typeof entry === "string" ? entry.trim() : "";
  if (!trimmed) {
    throw new Error("heldPaths entries must be non-empty repo-relative paths.");
  }
  if (trimmed.length > MAX_HELD_PATH_CHARS) {
    throw new Error(`heldPaths entries must be ${MAX_HELD_PATH_CHARS} characters or fewer.`);
  }
  const segments = trimmed.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (trimmed.startsWith("/") || /^[A-Za-z]:/.test(trimmed) || segments.includes("..")) {
    throw new Error(`heldPaths entry ${trimmed} must be a repo-relative path without .. segments.`);
  }
  if (!segments.length) {
    throw new Error(`heldPaths entry ${trimmed} must name a path inside the repository.`);
  }
  return segments.join("/") + (trimmed.endsWith("/") ? "/" : "");
}

/**
 * The PR files a board holds, in the PR's order: a file under a held
 * directory, or the held file itself. Matching stops at path segments, so
 * `server/webapp` holds `server/webapp/x.py` and not `server/webapp2/x.py`.
 */
export function matchHeldPaths(heldPaths: readonly string[], files: readonly string[]): string[] {
  return files.filter((file) =>
    heldPaths.some((held) =>
      held.endsWith("/") ? file.startsWith(held) : file === held || file.startsWith(`${held}/`),
    ),
  );
}
