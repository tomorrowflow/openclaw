import type { AudioTranscriptionRequest, AudioTranscriptionResult } from "../../types.js";
import {
  assertOkOrThrowHttpError,
  normalizeBaseUrl,
  postTranscriptionRequest,
  requireTranscriptionText,
} from "../shared.js";

export const DEFAULT_WHISPER_ASR_BASE_URL = "http://localhost:9009";
export const DEFAULT_FFMPEG_API_URL = "http://localhost:9008";

const FORMATS_NEEDING_CONVERSION = new Set(["m4a", "aac", "mp4", "ogg", "webm"]);

function resolveModel(model?: string): string {
  return model?.trim() || "faster-whisper";
}

function needsConversion(fileName: string, mime?: string): boolean {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  if (FORMATS_NEEDING_CONVERSION.has(ext)) {
    return true;
  }
  if (mime) {
    const sub = mime.split("/")[1]?.split(";")[0]?.trim().toLowerCase() ?? "";
    if (FORMATS_NEEDING_CONVERSION.has(sub) || sub === "x-m4a" || sub === "mp4") {
      return true;
    }
  }
  return false;
}

async function convertToMp3(params: {
  buffer: Buffer;
  fileName: string;
  mime?: string;
  ffmpegApiUrl: string;
  timeoutMs: number;
  fetchFn: typeof fetch;
}): Promise<{ buffer: Buffer; fileName: string; mime: string }> {
  const form = new FormData();
  const blob = new Blob([new Uint8Array(params.buffer)], {
    type: params.mime ?? "application/octet-stream",
  });
  form.append("file", blob, params.fileName);

  const url = `${normalizeBaseUrl(params.ffmpegApiUrl, DEFAULT_FFMPEG_API_URL)}/convert/audio/to/mp3`;
  const { response: res, release } = await postTranscriptionRequest({
    url,
    headers: new Headers(),
    body: form,
    timeoutMs: params.timeoutMs,
    fetchFn: params.fetchFn,
    allowPrivateNetwork: true,
  });

  try {
    await assertOkOrThrowHttpError(res, "FFmpeg audio conversion failed");
    const converted = Buffer.from(await res.arrayBuffer());
    const baseName = params.fileName.replace(/\.[^.]+$/, "");
    return { buffer: converted, fileName: `${baseName}.mp3`, mime: "audio/mpeg" };
  } finally {
    await release();
  }
}

export async function transcribeWhisperAsr(
  params: AudioTranscriptionRequest,
): Promise<AudioTranscriptionResult> {
  const fetchFn = params.fetchFn ?? fetch;
  const baseUrl = normalizeBaseUrl(params.baseUrl, DEFAULT_WHISPER_ASR_BASE_URL);
  const model = resolveModel(params.model);
  const ffmpegApiUrl = (params.query?.ffmpegApiUrl as string | undefined) ?? DEFAULT_FFMPEG_API_URL;

  let audioBuffer = params.buffer;
  let audioFileName = params.fileName;
  let audioMime = params.mime;

  // Convert non-mp3/wav formats via FFmpeg API
  if (needsConversion(audioFileName, audioMime)) {
    const converted = await convertToMp3({
      buffer: audioBuffer,
      fileName: audioFileName,
      mime: audioMime,
      ffmpegApiUrl,
      timeoutMs: params.timeoutMs,
      fetchFn,
    });
    audioBuffer = converted.buffer;
    audioFileName = converted.fileName;
    audioMime = converted.mime;
  }

  // Build multipart form for whisper-asr
  const form = new FormData();
  const blob = new Blob([new Uint8Array(audioBuffer)], { type: audioMime ?? "audio/mpeg" });
  form.append("audio_file", blob, audioFileName);

  const url = new URL(`${baseUrl}/asr`);
  url.searchParams.set("task", "transcribe");
  url.searchParams.set("output", "txt");
  if (params.language?.trim()) {
    url.searchParams.set("language", params.language.trim());
  }

  const { response: res, release } = await postTranscriptionRequest({
    url: url.toString(),
    headers: new Headers(),
    body: form,
    timeoutMs: params.timeoutMs,
    fetchFn,
    allowPrivateNetwork: true,
  });

  try {
    await assertOkOrThrowHttpError(res, "Whisper ASR transcription failed");
    // Whisper ASR returns plain text, not JSON
    const text = await res.text();
    const transcript = requireTranscriptionText(
      text,
      "Whisper ASR transcription response was empty",
    );
    return { text: transcript, model };
  } finally {
    await release();
  }
}
