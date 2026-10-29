import { expect, it } from "vitest";
import { normalizeAutomation } from "./store-normalizers.js";

it("keeps a ticket's repo-relative touches, trimmed and deduplicated, and clears them on an empty list", () => {
  const automation = normalizeAutomation({
    touches: [" App/Theme.swift ", "App/Tokens/", "App/Tokens"],
  });
  expect(automation?.touches).toEqual(["App/Theme.swift", "App/Tokens"]);
  expect(normalizeAutomation({ touches: [] }, automation)?.touches).toBeUndefined();
  for (const path of ["/abs/Theme.swift", "../Theme.swift", "App/./Theme.swift", "a\\b"]) {
    expect(() => normalizeAutomation({ touches: [path] })).toThrow("must be a repo-relative path");
  }
});
