#!/usr/bin/env python3
"""Dikte - yerel, anlık konuşma -> yazı sunucusu.

Mimari:
  Tarayıcı mikrofonu -> 16 kHz float32 PCM -> WebSocket
  Sunucu: enerji tabanlı ses/sessizlik takibi + faster-whisper (large-v3-turbo)
  Konuşurken ~0.35 sn'de bir "partial" (geçici) metin, cümle bitince "commit" (kesin) metin.
  Otomatik yazma açıksa commit metni odaktaki uygulamaya xdotool ile yazılır.
"""

from __future__ import annotations

import asyncio
import os
import re
import shutil
import subprocess
import time

# Kullanıcının ~/.cache/huggingface altındaki süresi geçmiş token'ı model indirmeyi bozmasın.
os.environ.setdefault("HF_HUB_DISABLE_IMPLICIT_TOKEN", "1")

import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")


def preload_cuda_libs() -> None:
    """pip ile gelen cuBLAS/cuDNN kütüphanelerini LD_LIBRARY_PATH gerekmeden yükle."""
    import ctypes
    import glob

    pattern = os.path.join(BASE_DIR, ".venv", "lib", "python3.*", "site-packages", "nvidia", "*", "lib", "*.so*")
    libs = []
    for path in glob.glob(pattern):
        libs.append(path)
    # bağımlılık sırası: cublas -> cudnn, birkaç tur denemek güvenli
    libs.sort(key=lambda p: (("cudnn" in p), ("nvrtc" in p), p))
    for _ in range(2):
        for lib in libs:
            try:
                ctypes.CDLL(lib, mode=ctypes.RTLD_GLOBAL)
            except OSError:
                pass


preload_cuda_libs()

MODEL_NAME = os.environ.get("DIKTE_MODEL", "deepdml/faster-whisper-large-v3-turbo-ct2")
LANGUAGE = "tr"
SR = 16000
FRAME = 512  # 32 ms

SILENCE_END = 0.55      # bu kadar sessizlik -> cümle bitti
MIN_COMMIT_AUDIO = 0.8  # commit için en az bu kadar ses
MAX_BUFFER = float(os.environ.get("DIKTE_MAX_BUFFER", "20"))  # daha uzun konuşmayı bölerek commit et
PARTIAL_EVERY = 0.10    # partial güncelleme aralığı

app = FastAPI(title="Dikte")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

model = None
model_device = "yükleniyor"
model_lock = asyncio.Lock()

# ---------------------------------------------------------------- yardımcılar


def clean_text(t: str) -> str:
    t = t.replace("\u200b", "").replace("\ufeff", "")
    t = re.sub(r"\s+", " ", t)
    t = re.sub(r"\s+([,.;:!?])", r"\1", t)
    t = t.strip()
    return t


BAD_ONLY = re.compile(r"^[\s.,;:!?\-–—…()\[\]\"']+$")
HALLUCINATION = re.compile(
    r"^(altyaz[ıi].*|abone ol.*|izlediğiniz için.*|thanks? for watching.*|"
    r"\[.*\]|\(.*\)|müzik|music|sessizlik|teşekkürler\.?)$",
    re.IGNORECASE,
)


def is_garbage(t: str) -> bool:
    if not t or BAD_ONLY.match(t):
        return True
    # aynı kelime 4+ kez tekrar ediyorsa halüsinasyondur
    words = t.split()
    if len(words) >= 6 and len(set(words)) <= 2:
        return True
    if HALLUCINATION.match(t.strip()) and len(t) < 60:
        return True
    return False


def frame_rms(a: np.ndarray) -> np.ndarray:
    n = len(a) // FRAME
    if n == 0:
        return np.zeros(1, dtype=np.float32)
    x = a[: n * FRAME].reshape(n, FRAME)
    return np.sqrt(np.mean(x * x, axis=1) + 1e-12)


def load_model() -> None:
    global model, model_device
    from faster_whisper import WhisperModel

    attempts = [
        ("cuda", "float16"),
        ("cpu", "int8"),
    ]
    for device, ctype in attempts:
        try:
            t0 = time.time()
            m = WhisperModel(
                MODEL_NAME,
                device=device,
                compute_type=ctype,
                cpu_threads=max(4, (os.cpu_count() or 4) // 2),
                num_workers=1,
            )
            # ilk çağrı ısınması
            warm = np.zeros(SR // 2, dtype=np.float32)
            list(m.transcribe(warm, language=LANGUAGE, beam_size=1)[0])
            model = m
            model_device = f"{device}/{ctype}"
            print(f"[dikte] model hazır: {MODEL_NAME} ({model_device}) {time.time()-t0:.1f}s")
            return
        except Exception as exc:  # noqa: BLE001
            print(f"[dikte] {device} başarısız: {type(exc).__name__}: {str(exc)[:300]}")
    raise RuntimeError("Model yüklenemedi")


def transcribe(audio: np.ndarray, prompt: str, quality: bool):
    """(metin, parçalar, kelimeler) döndürür; kelimeler yalnızca commit için hesaplanır."""
    if model is None or len(audio) < int(0.2 * SR):
        return "", [], []
    segments, _info = model.transcribe(
        audio,
        language=LANGUAGE,
        beam_size=5 if quality else 1,
        best_of=5 if quality else 1,
        temperature=0.0,
        condition_on_previous_text=False,
        initial_prompt=prompt or None,
        without_timestamps=False,
        word_timestamps=quality,
        vad_filter=False,
        no_speech_threshold=0.75,
    )
    parts = []
    timed: list[tuple[float, float, str]] = []
    words: list[tuple[float, float, str]] = []
    for seg in segments:
        if seg.no_speech_prob > 0.75 and seg.avg_logprob < -1.0:
            continue
        t = seg.text
        if t.strip():
            timed.append((seg.start, seg.end, t))
        if quality and seg.words:
            for w in seg.words:
                words.append((w.start, w.end, w.word))
        parts.append(t)
    return clean_text("".join(parts)), timed, words


# ---------------------------------------------------------------- otomatik yazma


class Typer:
    """Sabitlenen metni odaktaki uygulamaya aktarır.

    Wayland (KDE/GNOME) üzerinde xdotool çalışmadığı için sırasıyla
    ydotool (uinput, her yerde çalışır) -> xdotool (X11) -> wtype (wlroots)
    denenir. ydotool için Unicode güvenli yol: panoya kopyala + Ctrl+V.
    """

    def __init__(self) -> None:
        self.enabled = False
        self.backend = "yok"
        self.detail = ""
        self.q: asyncio.Queue[str] = asyncio.Queue()
        self.last_char = "\n"
        self.task: asyncio.Task | None = None
        self.ydotool_env: dict[str, str] | None = None
        self.wayland = bool(os.environ.get("WAYLAND_DISPLAY"))

    # -- kurulum
    def setup(self) -> None:
        self.backend, self.detail = self._detect()
        print(f"[dikte] otomatik yazma: {self.backend} {self.detail}".strip())
        self.task = asyncio.create_task(self._run())

    @property
    def available(self) -> bool:
        return self.backend != "yok"

    def _detect(self) -> tuple[str, str]:
        if shutil.which("ydotool"):
            sock = self._ensure_ydotoold()
            if sock:
                self.ydotool_env = dict(os.environ, YDOTOOL_SOCKET=sock)
                return "ydotool", f"({sock})"
        if shutil.which("xdotool"):
            return "xdotool", "(X11 / XWayland)"
        if shutil.which("wtype"):
            return "wtype", "(wlroots)"
        return "yok", "ydotool / xdotool / wtype bulunamadı"

    def _ensure_ydotoold(self) -> str | None:
        uid = os.getuid()
        candidates = [
            os.environ.get("YDOTOOL_SOCKET"),
            f"/run/user/{uid}/ydotoold.socket",
            f"/run/user/{uid}/.ydotool_socket",
            "/tmp/.ydotool_socket",
        ]
        for c in candidates:
            if c and os.path.exists(c):
                return c
        if not os.access("/dev/uinput", os.W_OK):
            return None
        sock = f"/tmp/.dikte-ydotool-{uid}.sock"
        try:
            subprocess.Popen(
                ["ydotoold", "--socket-path", sock, "--socket-perm=0600"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
        except Exception:  # noqa: BLE001
            return None
        for _ in range(20):
            if os.path.exists(sock):
                return sock
            time.sleep(0.05)
        return None

    # -- yazma
    async def _run(self) -> None:
        while True:
            text = await self.q.get()
            if not self.enabled or not text:
                continue
            prefix = " " if self.last_char not in " \n\t" else ""
            self.last_char = text[-1]
            try:
                await asyncio.to_thread(self._write, prefix + text)
            except Exception as exc:  # noqa: BLE001
                print("[dikte] yazma hatası:", type(exc).__name__, str(exc)[:120])
            await asyncio.sleep(0.05)

    def _write(self, payload: str) -> None:
        if self.backend == "ydotool":
            self._paste_via_ydotool(payload)
        elif self.backend == "xdotool":
            subprocess.run(
                ["xdotool", "type", "--clearmodifiers", "--delay", "6", "--", payload],
                check=False,
                timeout=90,
            )
        elif self.backend == "wtype":
            subprocess.run(["wtype", "--", payload], check=False, timeout=90)

    def _paste_via_ydotool(self, payload: str) -> None:
        """Panoyu kullanarak Unicode metni yapıştır, sonra eski panoyu geri koy."""
        assert self.ydotool_env is not None
        env = self.ydotool_env
        old: bytes | None = None
        if shutil.which("wl-paste") and self.wayland:
            try:
                old = subprocess.run(["wl-paste", "-n"], capture_output=True, timeout=1.5).stdout
            except Exception:  # noqa: BLE001
                old = None
        if shutil.which("wl-copy"):
            subprocess.run(["wl-copy"], input=payload.encode("utf-8"), env=env, timeout=5)
        elif shutil.which("xclip"):
            subprocess.run(["xclip", "-selection", "clipboard"], input=payload.encode("utf-8"), timeout=5)
        else:
            # pano aracı yok: doğrudan tuş taklidi
            subprocess.run(["ydotool", "type", "--", payload], env=env, check=False, timeout=90)
            return
        # Ctrl+V
        subprocess.run(
            ["ydotool", "key", "29:1", "47:1", "47:0", "29:0"],
            env=env,
            check=False,
            timeout=10,
        )
        time.sleep(0.35)
        if old is not None and shutil.which("wl-copy"):
            try:
                subprocess.run(["wl-copy"], input=old, env=env, timeout=3)
            except Exception:  # noqa: BLE001
                pass

    def feed(self, text: str) -> None:
        if self.enabled and self.available and text:
            self.q.put_nowait(text)


typer = Typer()

clients: set[WebSocket] = set()
main_loop: asyncio.AbstractEventLoop | None = None


async def broadcast(msg: dict) -> None:
    for c in list(clients):
        try:
            await c.send_json(msg)
        except Exception:  # noqa: BLE001
            clients.discard(c)


def start_hotkey() -> None:
    """F9 ile her yerden kaydı başlat/durdur."""
    try:
        from pynput import keyboard
    except Exception as exc:  # noqa: BLE001
        print("[dikte] global kısayol kapalı:", type(exc).__name__)
        return

    def on_press(key):
        if key == keyboard.Key.f9 and main_loop is not None:
            asyncio.run_coroutine_threadsafe(broadcast({"type": "hotkey"}), main_loop)

    try:
        listener = keyboard.Listener(on_press=on_press)
        listener.daemon = True
        listener.start()
        print("[dikte] global kısayol: F9")
    except Exception as exc:  # noqa: BLE001
        print("[dikte] global kısayol kapalı:", type(exc).__name__)


# ---------------------------------------------------------------- oturum


class Session:
    def __init__(self, ws: WebSocket) -> None:
        self.ws = ws
        self.buf = np.zeros(0, dtype=np.float32)
        self.prompt = ""
        self.committed_parts: list[str] = []
        self.partial = ""
        self.event = asyncio.Event()
        self.noise_floor = 0.003
        self.last_voice = 0.0
        self.had_speech = False
        self.last_partial_at = 0.0
        self.last_partial_text = ""
        self.started_at = time.time()
        self.busy = False
        self.plock = asyncio.Lock()
        self.paused = False

    # -- ses ekle
    def push(self, samples: np.ndarray) -> None:
        self.buf = np.concatenate([self.buf, samples])
        self.event.set()

    def speech_levels(self) -> tuple[np.ndarray, float, bool]:
        rms = frame_rms(self.buf)
        recent = rms[-8:]
        floor = float(np.percentile(rms, 10)) if len(rms) > 8 else self.noise_floor
        self.noise_floor = min(max(0.0008, 0.9 * self.noise_floor + 0.1 * floor), 0.02)
        thr = max(0.004, self.noise_floor * 2.8)
        voiced = bool(recent.max() > thr) if len(recent) else False
        return rms, thr, voiced

    def tail_is_silent(self, rms: np.ndarray, thr: float) -> bool:
        n = max(2, int(SILENCE_END * SR / FRAME))
        if len(rms) < n:
            return False
        return bool(rms[-n:].max() < thr)

    async def process(self, force: bool = False) -> None:
        async with self.plock:
            await self._process(force)

    async def _process(self, force: bool = False) -> None:
        if self.paused:
            return
        dur = len(self.buf) / SR
        if dur < 0.25:
            return

        rms, thr, voiced = self.speech_levels()
        if voiced:
            self.had_speech = True
            self.last_voice = time.time()

        silent_tail = self.tail_is_silent(rms, thr)
        endpoint = silent_tail and self.had_speech and dur >= MIN_COMMIT_AUDIO
        overflow = dur >= MAX_BUFFER and self.had_speech
        must_commit = force or endpoint or overflow

        # konuşma yoksa ve zaten sessizse boşuna model çalıştırma
        if not voiced and not self.had_speech:
            if dur > 2.0:
                self.reset_audio()
            return

        if not must_commit and (time.time() - self.last_partial_at) < PARTIAL_EVERY:
            return

        audio = np.array(self.buf, dtype=np.float32)
        prompt = self.prompt[-200:]
        self.busy = True
        try:
            t0 = time.time()
            async with model_lock:
                text, timed, words = await asyncio.to_thread(transcribe, audio, prompt, must_commit)
            elapsed_ms = int((time.time() - t0) * 1000)
        finally:
            self.busy = False

        if not must_commit:
            self.last_partial_at = time.time()
            if is_garbage(text):
                text = ""
            if text != self.last_partial_text:
                self.last_partial_text = text
                self.partial = text
                await self.send({"type": "partial", "text": text, "ms": elapsed_ms})
            return

        # --- commit
        keep_tail = False
        if overflow and not endpoint and not force:
            # Uzun kesintisiz konuşma: kelime sınırından kes, kalan sesi tamponda bırak.
            cut_limit = dur - 1.0
            picked = [w for w in words if w[1] <= cut_limit and not is_garbage(clean_text(w[2]))]
            if picked:
                text = clean_text("".join(w[2] for w in picked))
                cut = picked[-1][1]
                drop = max(0, int((cut - 0.08) * SR))
                if len(audio) - drop < int(0.4 * SR):
                    self.reset_audio()
                else:
                    self.buf = self.buf[drop:].copy()
                    keep_tail = True
            else:
                # kelime zamanı yoksa cümle sınırına düş
                complete = [s for s in timed if s[1] <= cut_limit and not is_garbage(clean_text(s[2]))]
                if complete:
                    text = clean_text("".join(s[2] for s in complete))
                    drop = max(0, int((complete[-1][1] - 0.08) * SR))
                    self.buf = self.buf[drop:].copy()
                    keep_tail = True
                else:
                    self.reset_audio()

        if is_garbage(text):
            text = ""
        if text and not self.paused:
            self.committed_parts.append(text)
            self.prompt = (self.prompt + " " + text)[-200:]
            await self.send({"type": "commit", "text": text, "dur": round(dur, 2), "ms": elapsed_ms})
            typer.feed(text)
        await self.send({"type": "partial", "text": ""})
        self.partial = ""
        self.last_partial_text = ""
        if keep_tail:
            self.had_speech = True
            self.last_partial_at = 0.0
        else:
            self.reset_audio()

    def reset_audio(self) -> None:
        self.buf = np.zeros(0, dtype=np.float32)
        self.had_speech = False

    async def send(self, msg: dict) -> None:
        try:
            await self.ws.send_json(msg)
        except Exception:  # noqa: BLE001
            pass

    async def worker(self) -> None:
        while True:
            try:
                await asyncio.wait_for(self.event.wait(), timeout=0.35)
            except asyncio.TimeoutError:
                if not self.busy and len(self.buf):
                    try:
                        await self.process()
                    except Exception as exc:  # noqa: BLE001
                        print("[dikte] işleme hatası:", type(exc).__name__, str(exc)[:200])
                continue
            self.event.clear()
            if not self.busy:
                try:
                    await self.process()
                except Exception as exc:  # noqa: BLE001
                    print("[dikte] işleme hatası:", type(exc).__name__, str(exc)[:200])


# ---------------------------------------------------------------- HTTP


@app.get("/")
async def index():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))


@app.get("/api/status")
async def status():
    return {
        "model": MODEL_NAME,
        "device": model_device,
        "language": LANGUAGE,
        "autotype": typer.enabled,
        "autotype_available": typer.available,
        "autotype_backend": typer.backend,
        "ready": model is not None,
    }


@app.post("/api/settings")
async def settings(payload: dict):
    if "autotype" in payload:
        typer.enabled = bool(payload["autotype"])
    return {"autotype": typer.enabled}


# ---------------------------------------------------------------- WebSocket


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket) -> None:
    await ws.accept()
    clients.add(ws)
    sess = Session(ws)
    worker = asyncio.create_task(sess.worker())
    await sess.send(
        {
            "type": "hello",
            "model": MODEL_NAME,
            "device": model_device,
            "autotype": typer.enabled,
            "autotype_available": typer.available,
            "autotype_backend": typer.backend,
        }
    )
    try:
        while True:
            msg = await ws.receive()
            if msg.get("type") == "websocket.disconnect":
                break
            if msg.get("bytes") is not None:
                if sess.paused:
                    continue
                data = np.frombuffer(msg["bytes"], dtype=np.float32)
                if data.size:
                    sess.push(data.copy())
            elif msg.get("text"):
                import json

                try:
                    obj = json.loads(msg["text"])
                except Exception:  # noqa: BLE001
                    continue
                kind = obj.get("type")
                if kind == "settings":
                    if "autotype" in obj:
                        typer.enabled = bool(obj["autotype"])
                    await ws.send_json({"type": "settings", "autotype": typer.enabled})
                elif kind == "flush":
                    await sess.process(force=True)
                    await ws.send_json({"type": "flushed"})
                elif kind == "pause_toggle":
                    sess.paused = not sess.paused
                    if sess.paused:
                        sess.reset_audio()
                        await sess.send({"type": "partial", "text": ""})
                    await ws.send_json({"type": "paused", "value": sess.paused})
                elif kind == "undo":
                    if sess.committed_parts:
                        sess.committed_parts.pop()
                        sess.prompt = (" ".join(sess.committed_parts))[-200:]
                elif kind == "client_commit":
                    text = clean_text(str(obj.get("text", "")))
                    if text and (not sess.committed_parts or sess.committed_parts[-1] != text):
                        sess.committed_parts.append(text)
                        sess.prompt = (" ".join(sess.committed_parts))[-200:]
                elif kind == "correct":
                    if sess.committed_parts:
                        replacement = clean_text(str(obj.get("text", "")))
                        if replacement:
                            sess.committed_parts[-1] = replacement
                        else:
                            sess.committed_parts.pop()
                        sess.prompt = (" ".join(sess.committed_parts))[-200:]
                elif kind == "reset":
                    sess.reset_audio()
                    sess.prompt = ""
                    sess.committed_parts.clear()
                    sess.last_partial_text = ""
                    sess.paused = False
                    await ws.send_json({"type": "partial", "text": ""})
                elif kind == "ping":
                    await ws.send_json({"type": "pong"})
    except WebSocketDisconnect:
        pass
    except Exception as exc:  # noqa: BLE001
        print("[dikte] ws hatası:", type(exc).__name__, str(exc)[:200])
    finally:
        clients.discard(ws)
        worker.cancel()


@app.on_event("startup")
async def startup() -> None:
    global main_loop
    main_loop = asyncio.get_running_loop()
    start_hotkey()
    await asyncio.to_thread(load_model)
    typer.setup()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        app,
        host=os.environ.get("DIKTE_HOST", "127.0.0.1"),
        port=int(os.environ.get("DIKTE_PORT", "8765")),
        log_level="warning",
    )
