import type { SpeechProviderPlugin } from "../../plugins/types.js";

const DEFAULT_KOKORO_URL = "http://localhost:3050";

async function kokoroTTS(params: {
  text: string;
  url: string;
  voice: string;
  lang: string;
  speed: number;
  timeoutMs?: number;
}): Promise<Buffer> {
  const { text, url, voice, lang, speed, timeoutMs } = params;
  const controller = new AbortController();
  const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
  try {
    const res = await fetch(`${url}/api/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, voice, lang, speed }),
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
      const lang = trimToString(overrides.lang, trimToString(cfg.lang, "en-us"));
      const speed = toNumber(overrides.speed, toNumber(cfg.speed, 1));
      const audioBuffer = await kokoroTTS({
        text: req.text,
        url: trimToString(cfg.url, DEFAULT_KOKORO_URL),
        voice,
        lang,
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
