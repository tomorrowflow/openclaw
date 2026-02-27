import { describe, expect, it } from "vitest";
import { buildMediaUnderstandingRegistry, getMediaUnderstandingProvider } from "./index.js";

describe("media-understanding provider registry", () => {
  it("registers the Mistral provider", () => {
    const registry = buildMediaUnderstandingRegistry();
    const provider = getMediaUnderstandingProvider("mistral", registry);

    expect(provider?.id).toBe("mistral");
    expect(provider?.capabilities).toEqual(["audio"]);
  });

  it("keeps provider id normalization behavior", () => {
    const registry = buildMediaUnderstandingRegistry();
    const provider = getMediaUnderstandingProvider("gemini", registry);

    expect(provider?.id).toBe("google");
  });

  it("registers the Moonshot provider", () => {
    const registry = buildMediaUnderstandingRegistry();
    const provider = getMediaUnderstandingProvider("moonshot", registry);

    expect(provider?.id).toBe("moonshot");
    expect(provider?.capabilities).toEqual(["image", "video"]);
  });

  it("registers the whisper-asr provider with audio capability", () => {
    const registry = buildMediaUnderstandingRegistry();
    const provider = getMediaUnderstandingProvider("whisper-asr", registry);

    expect(provider?.id).toBe("whisper-asr");
    expect(provider?.capabilities).toEqual(["audio"]);
    expect(provider?.transcribeAudio).toBeDefined();
  });
});
