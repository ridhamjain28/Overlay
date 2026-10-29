"""
Overlay Hinglish ASR server (optional).

A tiny OpenAI-compatible speech-to-text server that turns Hindi / Hinglish
speech straight into Roman-script Hinglish using the faster-whisper (CTranslate2)
model "MSpider3/whisper-hindi2hinglish-swift-ct2".

    POST http://127.0.0.1:8765/v1/audio/transcriptions   (multipart "file")
    GET  http://127.0.0.1:8765/health

Overlay starts this server by itself (hidden) once the speech helper and the
model are installed, and sends Hindi / Hinglish recordings to it.

Environment variables (all optional):
    HINGLISH_ASR_MODEL     model id or local folder (default above)
    HINGLISH_ASR_DEVICE    "cuda" or "cpu" (default: cuda, falls back to cpu)
    HINGLISH_ASR_COMPUTE   compute type (default: float16 on cuda, int8 on cpu)
    HINGLISH_ASR_HOST      bind address (default 127.0.0.1, keep it local)
    HINGLISH_ASR_PORT      port (default 8765)
    HINGLISH_ASR_LOG_DIR   folder for server.log (default: next to this file)
    HF_HOME                Hugging Face cache folder (reuse an existing cache)
"""

import logging
import os
import sys
import tempfile
import threading
import time

import uvicorn
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse, PlainTextResponse

MODEL_ID = os.environ.get("HINGLISH_ASR_MODEL", "MSpider3/whisper-hindi2hinglish-swift-ct2")
HOST = os.environ.get("HINGLISH_ASR_HOST", "127.0.0.1")
PORT = int(os.environ.get("HINGLISH_ASR_PORT", "8765"))

log = logging.getLogger("hinglish-asr")
_LOG_DIR = os.environ.get("HINGLISH_ASR_LOG_DIR") or os.path.dirname(os.path.abspath(__file__))
_handlers = []
try:
    _handlers.append(logging.FileHandler(os.path.join(_LOG_DIR, "server.log"), encoding="utf-8"))
except OSError:  # read-only install folder: skip the log file
    pass
if sys.stderr is not None:  # pythonw.exe has no console
    _handlers.append(logging.StreamHandler())
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", handlers=_handlers)

_model = None
_model_info = {}
_lock = threading.Lock()


def _add_cuda_dll_dirs():
    """On Windows, make the pip-installed cuBLAS/cuDNN DLLs findable."""
    if os.name != "nt":
        return
    try:
        import nvidia  # namespace package from nvidia-cublas-cu12 / nvidia-cudnn-cu12
    except ImportError:
        return
    for base in getattr(nvidia, "__path__", []):
        for sub in ("cublas", "cudnn"):
            path = os.path.join(base, sub, "bin")
            if os.path.isdir(path):
                os.add_dll_directory(path)
                os.environ["PATH"] = path + os.pathsep + os.environ.get("PATH", "")


def load_model():
    """Load once; try CUDA first, then CPU."""
    global _model
    if _model is not None:
        return _model
    _add_cuda_dll_dirs()
    from faster_whisper import WhisperModel

    wanted = os.environ.get("HINGLISH_ASR_DEVICE", "cuda").lower()
    attempts = [("cuda", os.environ.get("HINGLISH_ASR_COMPUTE", "float16"))] if wanted == "cuda" else []
    attempts.append(("cpu", os.environ.get("HINGLISH_ASR_COMPUTE_CPU", "int8")))
    last_error = None
    for device, compute in attempts:
        try:
            started = time.time()
            _model = WhisperModel(MODEL_ID, device=device, compute_type=compute)
            _model_info.update(device=device, compute_type=compute, load_seconds=round(time.time() - started, 1))
            log.info("Loaded %s on %s (%s) in %.1fs", MODEL_ID, device, compute, time.time() - started)
            return _model
        except Exception as error:  # noqa: BLE001 - report and try the next device
            last_error = error
            log.warning("Could not load on %s: %s", device, error)
    raise RuntimeError(f"Could not load model: {last_error}")


app = FastAPI(title="Overlay Hinglish ASR")


@app.get("/health")
def health():
    return {"ok": True, "model": MODEL_ID, "loaded": _model is not None, **_model_info}


@app.post("/v1/audio/transcriptions")
async def transcribe(
    file: UploadFile = File(...),
    model: str = Form(default=""),
    language: str = Form(default=""),
    prompt: str = Form(default=""),
    response_format: str = Form(default="json"),
    temperature: float = Form(default=0.0),
):
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="Empty audio file")
    suffix = os.path.splitext(file.filename or "")[1] or ".webm"
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    try:
        tmp.write(data)
        tmp.close()
        started = time.time()
        with _lock:
            whisper = load_model()
            # The model is fine-tuned to output Roman Hinglish when told the
            # audio is Hindi. "hi-Latn" etc. from the app map to "hi".
            lang = (language or "hi").split("-")[0] or "hi"
            segments, info = whisper.transcribe(
                tmp.name,
                language=lang,
                task="transcribe",
                beam_size=1,
                temperature=temperature,
                initial_prompt=prompt or None,
                vad_filter=True,
            )
            text = " ".join(segment.text.strip() for segment in segments).strip()
        log.info("Transcribed %.1fs of audio in %.2fs", info.duration, time.time() - started)
    finally:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass

    if response_format == "text":
        return PlainTextResponse(text)
    if response_format == "verbose_json":
        return JSONResponse({"text": text, "language": lang, "duration": info.duration})
    return JSONResponse({"text": text})


if __name__ == "__main__":
    if HOST not in ("127.0.0.1", "localhost", "::1"):
        log.warning("Binding to %s exposes this server to your network", HOST)
    if os.environ.get("HINGLISH_ASR_PRELOAD", "1") == "1":
        threading.Thread(target=load_model, daemon=True).start()
    uvicorn.run(app, host=HOST, port=PORT, log_config=None, log_level="warning")
