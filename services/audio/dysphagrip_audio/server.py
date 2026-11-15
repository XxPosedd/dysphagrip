"""FastAPI service: REST control + WebSocket frame stream.

REST
  GET  /health    liveness + running state
  GET  /devices   input devices with UM2 hints
  GET  /status    current source/config/errors
  POST /start     {"device": int|str|null, "channel": int, "samplerate": float|null}
  POST /stop
WebSocket
  /stream         {"type":"hello"} then {"type":"audio_frame"} every hop; {"type":"status"} on changes
GET /             standalone diagnostic viewer (no build step)
"""
from __future__ import annotations

import asyncio
import json
import logging
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Callable

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel

from .capture import DeviceSource, WavFileSource
from .config import AudioConfig
from .devices import DeviceNotFound, list_input_devices, resolve_device
from .processor import FrameProcessor
from .motion import MotionConfig, MotionStream, list_serial_ports

log = logging.getLogger("dysphagrip.audio")
STATIC = Path(__file__).parent / "static"

DEFAULT_ORIGINS = [
    "http://localhost:5173", "http://127.0.0.1:5173",   # Vite dev server
    "http://localhost:3000", "http://127.0.0.1:3000",   # Express (production build)
    "http://localhost:8765", "http://127.0.0.1:8765",   # this service's viewer
]


class MotionStartRequest(BaseModel):
    # "auto" | "serial:COM5" | "serial:/dev/cu.usbmodem101" | "tcp://HOST:PORT"
    source: str = "auto"


class StartRequest(BaseModel):
    device: int | str | None = None
    channel: int = 0
    samplerate: float | None = None


SourceFactory = Callable[[StartRequest, AudioConfig], Any]


def default_source_factory(wav_path: str | None = None) -> SourceFactory:
    def factory(req: StartRequest, cfg: AudioConfig):
        if wav_path:
            return WavFileSource(wav_path, channel=req.channel, buffer_seconds=cfg.buffer_seconds)
        device = resolve_device(req.device, list_input_devices())
        return DeviceSource(device, channel=req.channel, samplerate=req.samplerate,
                            buffer_seconds=cfg.buffer_seconds)
    return factory


class AudioService:
    def __init__(self, cfg: AudioConfig, source_factory: SourceFactory):
        self.cfg = cfg
        self.source_factory = source_factory
        self.source = None
        self.processor: FrameProcessor | None = None
        self.clients: set[WebSocket] = set()
        self.last_error: str | None = None
        self._task: asyncio.Task | None = None
        self._lock = asyncio.Lock()

    @property
    def running(self) -> bool:
        return self.source is not None

    def status(self) -> dict:
        return {
            "running": self.running,
            "source": self.source.info() if self.source else None,
            "dropped_samples": self.processor.dropped_total if self.processor else 0,
            "frames_sent": self.processor.seq if self.processor else 0,
            "clients": len(self.clients),
            "last_error": self.last_error,
            "config": self.cfg.to_dict(),
        }

    async def start(self, req: StartRequest) -> dict:
        async with self._lock:
            # Validate first (no stream opened yet) so a bad request leaves the current capture running.
            source = self.source_factory(req, self.cfg)   # may raise DeviceNotFound / ValueError
            await self._stop_locked()
            source.start()                                # may raise PortAudioError
            self.source = source
            self.processor = FrameProcessor(source, self.cfg)
            self.last_error = None
            self._task = asyncio.create_task(self._pump())
        await self.broadcast({"type": "status", **self.status()})
        return self.status()

    async def stop(self) -> dict:
        async with self._lock:
            await self._stop_locked()
        await self.broadcast({"type": "status", **self.status()})
        return self.status()

    async def _stop_locked(self) -> None:
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
            self._task = None
        if self.source is not None:
            try:
                self.source.stop()
            except Exception as exc:  # noqa: BLE001
                log.warning("error stopping source: %s", exc)
            self.source = None

    async def _pump(self) -> None:
        hop = self.cfg.hop_ms / 1000.0
        idle = 0.0
        loop = asyncio.get_running_loop()
        deadline = loop.time()
        while True:
            # Absolute deadlines: avoids cumulative drift from sleep overshoot (~15 ms on Windows).
            deadline += hop
            delay = deadline - loop.time()
            if delay < -hop:          # fell far behind (e.g. laptop sleep): resync instead of bursting
                deadline = loop.time()
                delay = 0.0
            await asyncio.sleep(max(0.0, delay))
            frame = self.processor.process() if self.processor else None
            if frame is not None:
                idle = 0.0
                await self.broadcast(frame)
                continue
            idle += hop
            if self.source is not None and not self.source.active and idle > 0.5:
                # Device unplugged, stream error, or non-looping file finished.
                self.last_error = "Audio source stopped unexpectedly (device disconnected or stream ended)."
                log.warning(self.last_error)
                await self.broadcast({"type": "error", "message": self.last_error})
                asyncio.create_task(self.stop())
                return
            if idle > 2.0 and self.source is not None:
                self.last_error = "No audio samples received for 2 s."
                await self.broadcast({"type": "error", "message": self.last_error})
                idle = 0.0

    async def broadcast(self, message: dict) -> None:
        if not self.clients:
            return
        text = json.dumps(message, separators=(",", ":"))
        dead = []

        async def send(ws: WebSocket):
            try:
                await asyncio.wait_for(ws.send_text(text), timeout=0.5)
            except Exception:  # noqa: BLE001
                dead.append(ws)

        await asyncio.gather(*(send(ws) for ws in list(self.clients)))
        for ws in dead:
            self.clients.discard(ws)


class MotionManager:
    """Runs at most one MotionStream and pumps its frames to WebSocket clients at ~20 Hz."""

    def __init__(self, service: "AudioService", factory: Callable[[str], MotionStream], hop_s: float = 0.05):
        self.service = service
        self.factory = factory
        self.hop_s = hop_s
        self.stream: MotionStream | None = None
        self._task: asyncio.Task | None = None
        self._was_receiving = False

    def status(self) -> dict:
        return {"running": self.stream is not None, **(self.stream.status() if self.stream else {})}

    async def start(self, spec: str) -> dict:
        stream = self.factory(spec)        # may raise LookupError / ValueError before anything is stopped
        await self.stop(broadcast=False)
        stream.start()
        self.stream = stream
        self._was_receiving = False
        self._task = asyncio.create_task(self._pump())
        await self.service.broadcast({"type": "motion_status", **self.status()})
        return self.status()

    async def stop(self, broadcast: bool = True) -> dict:
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
            self._task = None
        if self.stream is not None:
            await asyncio.to_thread(self.stream.stop)
            self.stream = None
        if broadcast:
            await self.service.broadcast({"type": "motion_status", **self.status()})
        return self.status()

    async def _pump(self) -> None:
        loop = asyncio.get_running_loop()
        deadline = loop.time()
        ticks = 0
        while True:
            deadline += self.hop_s
            await asyncio.sleep(max(0.0, deadline - loop.time()))
            stream = self.stream
            if stream is None:
                return
            frame = stream.drain_frame()
            if frame is not None:
                await self.service.broadcast(frame)
            receiving = stream.receiving
            ticks += 1
            # Status on change (sensor connected / lost) and once a second for sync/health numbers.
            if receiving != self._was_receiving or ticks % 20 == 0:
                self._was_receiving = receiving
                await self.service.broadcast({"type": "motion_status", **self.status()})


def create_app(cfg: AudioConfig | None = None, source_factory: SourceFactory | None = None,
               autostart: StartRequest | None = None, allowed_origins: list[str] | None = None,
               device_lister: Callable[[], list[dict]] = list_input_devices,
               motion_factory: Callable[[str], MotionStream] | None = None,
               port_lister: Callable[[], list[dict]] = list_serial_ports,
               motion_config: MotionConfig | None = None) -> FastAPI:
    cfg = cfg or AudioConfig()
    service = AudioService(cfg, source_factory or default_source_factory())
    motion = MotionManager(service, motion_factory or (lambda spec: MotionStream(spec, motion_config)))
    origins = allowed_origins or DEFAULT_ORIGINS

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        if autostart is not None:
            try:
                await service.start(autostart)
            except Exception as exc:  # noqa: BLE001 -- keep serving so the UI can show the error
                service.last_error = f"Autostart failed: {exc}"
                log.error(service.last_error)
        yield
        await motion.stop(broadcast=False)
        await service.stop()

    app = FastAPI(title="DysphaGrip audio service", version="0.1.0", lifespan=lifespan)
    app.state.service = service
    app.state.motion = motion
    app.add_middleware(CORSMiddleware, allow_origins=origins, allow_methods=["GET", "POST"],
                       allow_headers=["Content-Type"])

    @app.get("/health")
    async def health():
        return {"ok": True, "service": "dysphagrip-audio", "running": service.running,
                "motion_running": motion.stream is not None}

    @app.get("/devices")
    async def devices():
        try:
            devs = await asyncio.to_thread(device_lister)
        except Exception as exc:  # noqa: BLE001 -- e.g. PortAudio missing
            raise HTTPException(503, f"Could not query audio devices: {exc}") from exc
        from .devices import find_um2
        um2 = find_um2(devs)
        return {"devices": devs, "um2_candidate": um2["index"] if um2 else None}

    @app.get("/status")
    async def status():
        return service.status()

    @app.post("/start")
    async def start(req: StartRequest):
        try:
            return await service.start(req)
        except DeviceNotFound as exc:
            service.last_error = str(exc)
            raise HTTPException(404, str(exc)) from exc
        except ValueError as exc:
            service.last_error = str(exc)
            raise HTTPException(400, str(exc)) from exc
        except Exception as exc:  # noqa: BLE001 -- PortAudioError and friends
            service.last_error = f"Could not open audio input: {exc}"
            raise HTTPException(500, service.last_error) from exc

    @app.post("/stop")
    async def stop():
        return await service.stop()

    # ---- Motion (MPU-6050 via Arduino UNO Q) ----
    @app.get("/motion/ports")
    async def motion_ports():
        return {"ports": await asyncio.to_thread(port_lister)}

    @app.get("/motion/status")
    async def motion_status():
        return motion.status()

    @app.post("/motion/start")
    async def motion_start(req: MotionStartRequest):
        try:
            return await motion.start(req.source)
        except LookupError as exc:
            raise HTTPException(404, str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc

    @app.post("/motion/stop")
    async def motion_stop():
        return await motion.stop()

    @app.websocket("/stream")
    async def stream(ws: WebSocket):
        origin = ws.headers.get("origin")
        if origin and origin not in origins:
            await ws.close(code=1008)
            return
        await ws.accept()
        service.clients.add(ws)
        await ws.send_text(json.dumps({"type": "hello", **service.status(), "motion": motion.status()}))
        try:
            while True:
                await ws.receive_text()   # clients don't need to send; this detects disconnect
        except WebSocketDisconnect:
            pass
        finally:
            service.clients.discard(ws)

    @app.get("/")
    async def viewer():
        return FileResponse(STATIC / "index.html")

    return app
