/**
 * A POSIX path relative to a repo or worktree without a trailing slash, or
 * undefined when it is empty, has "." or ".." segments, or uses backslashes.
 */
export function relativeRepoPath(value: unknown): string | undefined {
  const path = typeof value === "string" ? value.trim().replace(/\/+$/, "") : "";
  const segments = path.split("/");
  return path &&
    !path.includes("\\") &&
    !segments.some((segment) => !segment || segment === "." || segment === "..")
    ? path
    : undefined;
}

// Workboard paths accept POSIX, drive-letter, and UNC absolute forms.
export function isAbsoluteWorkspacePath(value: string): boolean {
  return (
    value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value)
  );
}
