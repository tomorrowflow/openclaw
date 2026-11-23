import { expect, it } from "vitest";
import { flowScreenshotPath, flowScreenshotPaths } from "./flow-links.ts";

const REPORT = "docs/flows/dictation.html";

it.each([
  [
    "../screenshots/LIN-2.04/dictation-ipad-B.png",
    "docs/screenshots/LIN-2.04/dictation-ipad-B.png",
  ],
  ["./../screenshots/a.JPEG#top", "docs/screenshots/a.JPEG"],
  ["../screenshots/LIN%201/a%20b.webp?raw=1", "docs/screenshots/LIN 1/a b.webp"],
  ["../../docs/screenshots/x/../y/z.gif", "docs/screenshots/y/z.gif"],
])("resolves %s against the report to %s", (href, path) => {
  expect(flowScreenshotPath(REPORT, href)).toBe(path);
});

it.each([
  ["a path above the repository", "../../../etc/screenshots/a.png"],
  ["a path that escapes and re-enters under another root", "../../../docs/screenshots/a.png"],
  ["another directory", "../prototypes/T-1/a.png"],
  ["a sibling report", "other.html"],
  ["a file that is not an image", "../screenshots/LIN-1/notes.html"],
  ["an encoded separator", "../screenshots/LIN-1%2F..%2F..%2Fsecret.png"],
  ["a host-absolute path", "/docs/screenshots/a.png"],
  ["an external address", "https://example.com/docs/screenshots/a.png"],
  ["a protocol-relative address", "//example.com/docs/screenshots/a.png"],
  ["a script address", "javascript:alert(1)"],
  ["a malformed escape", "../screenshots/%E0%A4%A.png"],
  ["a fragment", "#section"],
  ["nothing", ""],
  ["a script address behind leading whitespace", " javascript:alert(1)"],
  ["a script address behind a tab", "java\tscript:alert(1)"],
  ["a backslash-absolute address", "\\\\example.com\\docs\\screenshots\\a.png"],
  ["an encoded dot segment", "../screenshots/%2e%2e/%2e%2e/secret.png"],
  ["an encoded backslash", "../screenshots/LIN-1%5C..%5Ca.png"],
])("ignores %s", (_name, href) => {
  expect(flowScreenshotPath(REPORT, href)).toBeUndefined();
});

it("lists each screenshot a report links to once, in document order", () => {
  const html = `
    <a class="shot" href="../screenshots/LIN-2/b.png">B</a>
    <a href='../screenshots/LIN-1/a.png'>A</a>
    <a href="../screenshots/LIN-2/b.png#again">B again</a>
    <a href="https://example.com/x.png">external</a>
    <img src="../screenshots/LIN-3/inline.png">
    <a href="#top">top</a>`;
  expect(flowScreenshotPaths(REPORT, html)).toEqual([
    "docs/screenshots/LIN-2/b.png",
    "docs/screenshots/LIN-1/a.png",
  ]);
});
