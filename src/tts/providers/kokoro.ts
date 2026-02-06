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
    if (timer) clearTimeout(timer);
  }
}

export function buildKokoroSpeechProvider(): SpeechProviderPlugin {
  return {
    id: "kokoro",
    label: "Kokoro",
    isConfigured: ({ config }) => config.kokoro.enabled,
    synthesize: async (req) => {
      const kokoroVoice = req.overrides?.kokoro?.voice ?? req.config.kokoro.voice;
      const kokoroLang = req.overrides?.kokoro?.lang ?? req.config.kokoro.lang;
      const kokoroSpeed = req.overrides?.kokoro?.speed ?? req.config.kokoro.speed;
      const audioBuffer = await kokoroTTS({
        text: req.text,
        url: req.config.kokoro.url || DEFAULT_KOKORO_URL,
        voice: kokoroVoice,
        lang: kokoroLang,
        speed: kokoroSpeed,
        timeoutMs: req.config.kokoro.timeoutMs ?? req.config.timeoutMs,
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
