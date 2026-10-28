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

Measured on an RTX 5060 Laptop GPU (8 GB), Windows 11, Python 3.11: the model
loaded on CUDA (float16) in 3 s and the whole GPU showed about 330 MiB in use.
The server process used about 750 MB of RAM. The first request after start
took about 18 s (GPU warm-up); after that a 5.7 s clip took 0.16 s. The first
`start.bat` run downloads about 1.5 GB of Python packages (mostly the CUDA
libraries). If you see out-of-memory errors next to a big Ollama model, set
`HINGLISH_ASR_DEVICE=cpu`.
