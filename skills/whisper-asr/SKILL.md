# Whisper ASR (Speech-to-Text)

Local CPU-only speech-to-text via [Whisper ASR WebService](https://github.com/ahmetoner/whisper-asr-webservice) running faster-whisper.

## Endpoints

| Service     | URL                     | Purpose                      |
| ----------- | ----------------------- | ---------------------------- |
| Whisper ASR | `http://localhost:9009` | Speech-to-text transcription |
| FFmpeg API  | `http://localhost:9008` | Audio format conversion      |

## Transcribe Audio

```bash
# Transcribe an audio file (mp3, wav, flac)
curl -F "audio_file=@recording.mp3" \
  "http://localhost:9009/asr?task=transcribe&output=txt"
```

Plain text transcript is returned directly (not JSON).

## Output Formats

| Format | Description          |
| ------ | -------------------- |
| `txt`  | Plain text (default) |
| `json` | JSON with timestamps |
| `vtt`  | WebVTT subtitles     |
| `srt`  | SRT subtitles        |
| `tsv`  | Tab-separated values |

```bash
# Get JSON with word timestamps
curl -F "audio_file=@recording.mp3" \
  "http://localhost:9009/asr?task=transcribe&output=json&word_timestamps=true"

# Get SRT subtitles
curl -F "audio_file=@recording.mp3" \
  "http://localhost:9009/asr?task=transcribe&output=srt"
```

## Language Detection

```bash
# Auto-detect language
curl -F "audio_file=@recording.mp3" \
  "http://localhost:9009/asr?task=transcribe&output=json"

# Force a specific language
curl -F "audio_file=@recording.mp3" \
  "http://localhost:9009/asr?task=transcribe&output=txt&language=fr"
```

## Audio Conversion (FFmpeg API)

Convert audio formats before transcription if needed (e.g. m4a, aac, ogg, webm).

```bash
# Convert m4a to mp3
curl -F "file=@voice.m4a" \
  "http://localhost:9008/convert/audio/to/mp3" -o voice.mp3
```

## Notes

- Runs on CPU only; no GPU required.
- The multipart form field name is `audio_file` for Whisper ASR and `file` for FFmpeg API.
- For best results with non-mp3/wav formats, convert via FFmpeg API first.
