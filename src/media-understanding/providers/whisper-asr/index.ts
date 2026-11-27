import type { MediaUnderstandingProvider } from "../../provider-types.js";
import { transcribeWhisperAsr } from "./audio.js";

export const whisperAsrProvider: MediaUnderstandingProvider = {
  id: "whisper-asr",
  capabilities: ["audio"],
  transcribeAudio: transcribeWhisperAsr,
};
