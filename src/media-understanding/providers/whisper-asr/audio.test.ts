import { describe, expect, it, vi } from "vitest";
import type { AudioTranscriptionRequest } from "../../types.js";
import { transcribeWhisperAsr } from "./audio.js";

function mockFetch(responses: Array<{ ok: boolean; status?: number; body: string | ArrayBuffer }>) {
  let callIndex = 0;
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
    const entry = responses[callIndex++];
    if (!entry) {
      throw new Error("Unexpected fetch call");
    }
    return {
      ok: entry.ok,
      status: entry.status ?? (entry.ok ? 200 : 500),
      text: async () => (typeof entry.body === "string" ? entry.body : ""),
      arrayBuffer: async () =>
        typeof entry.body === "string" ? new TextEncoder().encode(entry.body).buffer : entry.body,
      json: async () => JSON.parse(typeof entry.body === "string" ? entry.body : "{}"),
      headers: new Headers(),
    } as unknown as Response;
  });
}

function baseParams(overrides?: Partial<AudioTranscriptionRequest>): AudioTranscriptionRequest {
  return {
    buffer: Buffer.from("fake-audio"),
    fileName: "test.mp3",
    mime: "audio/mpeg",
    apiKey: "local",
    timeoutMs: 10_000,
    ...overrides,
  };
}

describe("transcribeWhisperAsr", () => {
  it("sends multipart form with audio_file field for mp3", async () => {
    const fetchFn = mockFetch([{ ok: true, body: "Hello world" }]);
    const result = await transcribeWhisperAsr(baseParams({ fetchFn: fetchFn as typeof fetch }));

    expect(result.text).toBe("Hello world");
    expect(result.model).toBe("faster-whisper");
    expect(fetchFn).toHaveBeenCalledTimes(1);

    const [url] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/asr");
    expect(url).toContain("task=transcribe");
    expect(url).toContain("output=txt");
  });

  it("converts m4a via ffmpeg API before transcription", async () => {
    const mp3Buffer = new Uint8Array([0xff, 0xfb]).buffer;
    const fetchFn = mockFetch([
      // First call: ffmpeg conversion
      { ok: true, body: mp3Buffer },
      // Second call: whisper transcription
      { ok: true, body: "Converted transcript" },
    ]);

    const result = await transcribeWhisperAsr(
      baseParams({
        fileName: "voice.m4a",
        mime: "audio/x-m4a",
        fetchFn: fetchFn as typeof fetch,
      }),
    );

    expect(result.text).toBe("Converted transcript");
    expect(fetchFn).toHaveBeenCalledTimes(2);

    const [convertUrl] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(convertUrl).toContain("/convert/audio/to/mp3");

    const [asrUrl] = fetchFn.mock.calls[1] as [string, RequestInit];
    expect(asrUrl).toContain("/asr");
  });

  it("converts aac via ffmpeg API", async () => {
    const mp3Buffer = new Uint8Array([0xff, 0xfb]).buffer;
    const fetchFn = mockFetch([
      { ok: true, body: mp3Buffer },
      { ok: true, body: "AAC transcript" },
    ]);

    const result = await transcribeWhisperAsr(
      baseParams({
        fileName: "audio.aac",
        mime: "audio/aac",
        fetchFn: fetchFn as typeof fetch,
      }),
    );

    expect(result.text).toBe("AAC transcript");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("does not convert wav files", async () => {
    const fetchFn = mockFetch([{ ok: true, body: "WAV transcript" }]);

    const result = await transcribeWhisperAsr(
      baseParams({
        fileName: "audio.wav",
        mime: "audio/wav",
        fetchFn: fetchFn as typeof fetch,
      }),
    );

    expect(result.text).toBe("WAV transcript");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("passes language parameter", async () => {
    const fetchFn = mockFetch([{ ok: true, body: "Bonjour" }]);

    await transcribeWhisperAsr(
      baseParams({
        language: "fr",
        fetchFn: fetchFn as typeof fetch,
      }),
    );

    const [url] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("language=fr");
  });

  it("throws on whisper-asr HTTP error", async () => {
    const fetchFn = mockFetch([{ ok: false, status: 500, body: "Internal Server Error" }]);

    await expect(
      transcribeWhisperAsr(baseParams({ fetchFn: fetchFn as typeof fetch })),
    ).rejects.toThrow("Whisper ASR transcription failed");
  });

  it("throws on empty transcription", async () => {
    const fetchFn = mockFetch([{ ok: true, body: "   " }]);

    await expect(
      transcribeWhisperAsr(baseParams({ fetchFn: fetchFn as typeof fetch })),
    ).rejects.toThrow("Whisper ASR transcription response was empty");
  });

  it("throws on ffmpeg conversion failure", async () => {
    const fetchFn = mockFetch([{ ok: false, status: 422, body: "Unsupported format" }]);

    await expect(
      transcribeWhisperAsr(
        baseParams({
          fileName: "voice.m4a",
          mime: "audio/x-m4a",
          fetchFn: fetchFn as typeof fetch,
        }),
      ),
    ).rejects.toThrow("FFmpeg audio conversion failed");
  });

  it("uses custom ffmpegApiUrl from query", async () => {
    const mp3Buffer = new Uint8Array([0xff, 0xfb]).buffer;
    const fetchFn = mockFetch([
      { ok: true, body: mp3Buffer },
      { ok: true, body: "Custom ffmpeg" },
    ]);

    await transcribeWhisperAsr(
      baseParams({
        fileName: "voice.m4a",
        mime: "audio/x-m4a",
        query: { ffmpegApiUrl: "http://localhost:8080" },
        fetchFn: fetchFn as typeof fetch,
      }),
    );

    const [convertUrl] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(convertUrl).toContain("http://localhost:8080/convert/audio/to/mp3");
  });

  it("uses custom baseUrl", async () => {
    const fetchFn = mockFetch([{ ok: true, body: "Custom ASR" }]);

    await transcribeWhisperAsr(
      baseParams({
        baseUrl: "http://localhost:9999",
        fetchFn: fetchFn as typeof fetch,
      }),
    );

    const [url] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("http://localhost:9999/asr");
  });
});
