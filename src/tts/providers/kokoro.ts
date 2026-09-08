import type { SpeechProviderPlugin } from "../../plugins/types.js";

const DEFAULT_KOKORO_URL = "http://localhost:9007";

async function kokoroTTS(params: {
  text: string;
  url: string;
  voice: string;
  speed: number;
  timeoutMs?: number;
}): Promise<Buffer> {
  const { text, url, voice, speed, timeoutMs } = params;
  const controller = new AbortController();
  const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
  try {
    // kokoro-fastapi uses the OpenAI-compatible /v1/audio/speech endpoint
    const res = await fetch(`${url}/v1/audio/speech`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "kokoro",
        input: text,
        voice,
        speed,
        response_format: "mp3",
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      throw new Error(`Kokoro TTS HTTP ${res.status}: ${errBody}`);
    }
    return Buffer.from(await res.arrayBuffer());
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function trimToString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function toNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function buildKokoroSpeechProvider(): SpeechProviderPlugin {
  return {
    id: "kokoro",
    label: "Kokoro",
    isConfigured: ({ providerConfig }) => providerConfig.enabled === true,
    synthesize: async (req) => {
      const cfg = req.providerConfig;
      const overrides = req.providerOverrides ?? {};
      const voice = trimToString(overrides.voice, trimToString(cfg.voice, "af_heart"));
      const speed = toNumber(overrides.speed, toNumber(cfg.speed, 1));
      const audioBuffer = await kokoroTTS({
        text: req.text,
        url: trimToString(cfg.url, DEFAULT_KOKORO_URL),
        voice,
        speed,
        timeoutMs: toNumber(cfg.timeoutMs, req.timeoutMs),
      });
      return {
        audioBuffer,
        outputFormat: "mp3",
        fileExtension: ".mp3",
        voiceCompatible: false,
      };
    },
  };
}
