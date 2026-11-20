import { describe, expect, it } from "vitest";
import {
  hasSanitizedSendPayloadContent,
  sanitizeMessageToolVisiblePayload,
} from "./message-tool-visible-content.js";

const cronRun = "agent:main:cron:heartbeat-main:run:run-1";

describe("sanitizeMessageToolVisiblePayload silent token", () => {
  it("empties a bare NO_REPLY from a scheduled run so nothing is sent", () => {
    const params: Record<string, unknown> = { message: " no_reply\n" };
    expect(sanitizeMessageToolVisiblePayload(params, cronRun)).toBe("silent_reply_token");
    expect(params.message).toBe("");
    expect(hasSanitizedSendPayloadContent(params)).toBe(false);
  });

  it("keeps a scheduled run's media when only the caption was NO_REPLY", () => {
    const params: Record<string, unknown> = {
      caption: "NO_REPLY",
      mediaUrl: "file:///tmp/status.png",
    };
    expect(sanitizeMessageToolVisiblePayload(params, cronRun)).toBe("silent_reply_token");
    expect(params.caption).toBe("");
    expect(hasSanitizedSendPayloadContent(params)).toBe(true);
  });

  it("leaves chat sends and prose mentioning NO_REPLY untouched", () => {
    const chat: Record<string, unknown> = { message: "NO_REPLY" };
    expect(
      sanitizeMessageToolVisiblePayload(chat, "agent:main:signal:direct:+15551234567"),
    ).toBeUndefined();
    expect(chat.message).toBe("NO_REPLY");
    const prose: Record<string, unknown> = { message: "Checked, nothing new.\nNO_REPLY" };
    expect(sanitizeMessageToolVisiblePayload(prose, cronRun)).toBeUndefined();
    expect(prose.message).toBe("Checked, nothing new.\nNO_REPLY");
  });
});
