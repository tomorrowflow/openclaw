# Kokoro TTS (Text-to-Speech)

Local CPU-only text-to-speech via [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI), an OpenAI-compatible TTS server.

## Endpoint

`http://localhost:9007/v1/audio/speech`

## Generate Speech

```bash
curl -X POST http://localhost:9007/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{
    "model": "kokoro",
    "input": "Hello, this is a test of Kokoro text to speech.",
    "voice": "af_heart",
    "response_format": "mp3",
    "speed": 1.0
  }' -o output.mp3
```

Returns raw audio bytes in the requested format.

## Parameters

| Parameter         | Type    | Default    | Description                                        |
| ----------------- | ------- | ---------- | -------------------------------------------------- |
| `model`           | string  | `kokoro`   | Model name                                         |
| `input`           | string  | required   | Text to speak                                      |
| `voice`           | string  | `af_heart` | Voice ID                                           |
| `response_format` | string  | `mp3`      | Output format: `mp3`, `wav`, `opus`, `flac`, `aac` |
| `speed`           | number  | `1.0`      | Speed multiplier (0.25-4.0)                        |
| `stream`          | boolean | `false`    | Enable streaming response                          |
| `lang_code`       | string  | `en-us`    | Language code                                      |

## Available Voices

| Voice        | Description               |
| ------------ | ------------------------- |
| `af_heart`   | American female (warm)    |
| `af_bella`   | American female (clear)   |
| `af_sarah`   | American female (neutral) |
| `af_nicole`  | American female (soft)    |
| `am_adam`    | American male (deep)      |
| `am_michael` | American male (neutral)   |
| `bf_emma`    | British female            |
| `bm_george`  | British male              |

Combine voices by joining with `+`: `af_heart+af_bella` blends both voices.

## List Available Voices

```bash
curl http://localhost:9007/v1/audio/voices
```

## Notes

- Runs on CPU only; no GPU required.
- OpenAI-compatible API; can also be used via `OPENAI_TTS_BASE_URL=http://localhost:9007/v1` with provider `openai` and model `kokoro`.
- Language codes follow BCP-47 lowercase format (e.g. `en-us`, `ja`, `fr-fr`).
