/**
 * The commit a node ticket worktree starts from. A commit base, such as a
 * probe's, may be gone from every origin branch after a force-push; origin
 * still serves it by id while it keeps the object, so a commit id that does
 * not resolve is fetched once. Undefined when it still does not resolve.
 */
export async function resolveNodeBaseCommit(params: {
  git: (...args: string[]) => Promise<string>;
  baseRef: string;
  isCommitId: boolean;
}): Promise<string | undefined> {
  const resolve = () =>
    params
      .git("rev-parse", "--verify", "--quiet", `${params.baseRef}^{commit}`)
      .catch(() => undefined);
  const resolved = await resolve();
  if (resolved !== undefined || !params.isCommitId) {
    return resolved;
  }
  return await params
    .git("fetch", "--quiet", "origin", params.baseRef)
    .then(resolve, () => undefined);
}
