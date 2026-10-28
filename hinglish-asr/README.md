# Hinglish ASR server (optional)

A small local speech-to-text server that writes Hindi/Hinglish speech directly
in **Roman script** ("kal meeting 5 baje hai"), using the faster-whisper model
[`MSpider3/whisper-hindi2hinglish-swift-ct2`](https://huggingface.co/MSpider3/whisper-hindi2hinglish-swift-ct2).
Overlay works without it; use it only if you dictate a lot of Hinglish.

## Start

1. Install Python 3.10–3.12 (python.org), once.
2. Double-click `start.bat`. The first run creates `.venv`, installs packages
   (`install.log`), and downloads the model into your Hugging Face cache. It
   then runs in the background with no window; logs go to `server.log`.
3. Check http://127.0.0.1:8765/health in a browser: `"loaded": true` means ready.
4. In Overlay: **Settings → Speech-to-Text → Self-hosted**, URL
   `http://127.0.0.1:8765/v1`.

Stop it with `stop.bat`.

## Options (environment variables)

| Variable              | Default     | Meaning                              |
| --------------------- | ----------- | ------------------------------------ |
| `HINGLISH_ASR_DEVICE` | `cuda`      | `cpu` to keep the GPU free (slower)  |
| `HINGLISH_ASR_PORT`   | `8765`      | Port                                 |
| `HINGLISH_ASR_HOST`   | `127.0.0.1` | Keep it on localhost                 |
| `HF_HOME`             | HF default  | Reuse an existing Hugging Face cache |

## API

`POST /v1/audio/transcriptions` (multipart field `file`, optional `language`,
`prompt`, `response_format` = `json` | `text` | `verbose_json`) → `{"text": "..."}`.
Same shape as OpenAI's endpoint, so any OpenAI-compatible client works.

Notes: it uses roughly 1–2 GB of VRAM on CUDA. Don't run it together with a
large Ollama model on an 8 GB GPU if you see out-of-memory errors.
