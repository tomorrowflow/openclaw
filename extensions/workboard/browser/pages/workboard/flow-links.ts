const SCREENSHOT_DIR = "docs/screenshots/";
const IMAGE = /\.(?:png|jpe?g|gif|webp)$/i;
// `<a href>` only: a flow report is self-contained HTML and reaches screenshots through links.
const ANCHOR_HREF = /<a\s[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;

// The repository sits under a prefix so a link that climbs above it resolves outside the prefix.
const REPO_ROOT = "https://repository.invalid/repo/";

/**
 * The repository path of the screenshot a flow report's link names, resolved
 * against the report's own path. Undefined for anything else: an absolute or
 * external address, a path that leaves the repository or `docs/screenshots/`,
 * or a file that is not an image. The href is untrusted (the report's scripts
 * can send any string), so the URL parser resolves it exactly as given.
 */
export function flowScreenshotPath(reportPath: string, href: string): string | undefined {
  const root = new URL(REPO_ROOT);
  let path: string;
  try {
    const resolved = new URL(href, new URL(reportPath, root));
    if (resolved.origin !== root.origin || !resolved.pathname.startsWith(root.pathname)) {
      return undefined;
    }
    path = decodeURIComponent(resolved.pathname.slice(root.pathname.length));
  } catch {
    return undefined;
  }
  // An encoded separator or dot segment only appears after decoding.
  const inside = path.split("/").every((segment) => segment && segment !== "." && segment !== "..");
  return inside && !path.includes("\\") && path.startsWith(SCREENSHOT_DIR) && IMAGE.test(path)
    ? path
    : undefined;
}

/** The screenshots a flow report links to, each once, in document order. */
export function flowScreenshotPaths(reportPath: string, html: string): string[] {
  const paths = new Set<string>();
  for (const match of html.matchAll(ANCHOR_HREF)) {
    const path = flowScreenshotPath(
      reportPath,
      (match[1] ?? match[2] ?? "").replaceAll("&amp;", "&"),
    );
    if (path) {
      paths.add(path);
    }
  }
  return [...paths];
}
