// Heartbeat reply normalization: acknowledgement tokens never reach the owner,
// whether they lead, trail, or are appended to prose.
import { describe, expect, it } from "vitest";
import { normalizeHeartbeatReply } from "./heartbeat-reply-normalization.js";

const ACK_MAX_CHARS = 300;

describe("normalizeHeartbeatReply", () => {
  it("delivers plain prose untouched", () => {
    const result = normalizeHeartbeatReply(
      { text: "Meeting in 30 minutes." },
      undefined,
      ACK_MAX_CHARS,
    );
    expect(result).toMatchObject({ shouldSkip: false, text: "Meeting in 30 minutes." });
    expect(result.silent).toBeUndefined();
  });

  it("skips a bare silent token", () => {
    expect(normalizeHeartbeatReply({ text: "NO_REPLY" }, undefined, ACK_MAX_CHARS)).toMatchObject({
      shouldSkip: true,
      text: "",
      silent: true,
    });
  });

  it("treats a short status followed by a trailing silent token as an acknowledgement", () => {
    expect(
      normalizeHeartbeatReply(
        { text: "All priority checks clear.\n\nNO_REPLY" },
        undefined,
        ACK_MAX_CHARS,
      ),
    ).toMatchObject({ shouldSkip: true, text: "", silent: true });
  });

  it("never delivers acknowledgement tokens appended to a long status", () => {
    // Observed 2026-09-11 16:06: the owner received both tokens verbatim.
    const status = [
      "All priority checks clear:",
      "",
      "• No pending inbox tasks (Inbox empty).",
      "• No work or private calendar events starting in the next 2 hours — the business calendar only shows all-day OOO entries, and the private calendar is empty for this window.",
      "• Email digest not checked per the owner's earlier request.",
      "",
      "Last heartbeat was 49 minutes ago. No urgent items. Quiet hours don't apply (16:06).",
    ].join("\n");
    const result = normalizeHeartbeatReply(
      { text: `${status}\n\nHEARTBEAT_OK — no proactive message needed.\n\nNO_REPLY` },
      undefined,
      ACK_MAX_CHARS,
    );
    expect(result.shouldSkip).toBe(false);
    expect(result.silent).toBe(true);
    expect(result.text).not.toContain("HEARTBEAT_OK");
    expect(result.text).not.toContain("NO_REPLY");
    expect(result.text).not.toContain("no proactive message needed");
    // Token stripping collapses whitespace; the status content itself survives.
    expect(result.text).toContain("All priority checks clear:");
    expect(result.text).toContain("Quiet hours don't apply (16:06).");
  });

  it("keeps a long status that ends with a silent token, without the token", () => {
    const long = "y".repeat(400);
    expect(
      normalizeHeartbeatReply({ text: `${long}\n\nNO_REPLY` }, undefined, ACK_MAX_CHARS),
    ).toMatchObject({ shouldSkip: false, text: long, silent: true });
  });

  it("does not skip media on an acknowledgement", () => {
    expect(
      normalizeHeartbeatReply(
        { text: "Snapshot attached.\nNO_REPLY", mediaUrl: "https://example.com/a.png" },
        undefined,
        ACK_MAX_CHARS,
      ),
    ).toMatchObject({ shouldSkip: false, hasMedia: true, text: "Snapshot attached." });
  });
});
