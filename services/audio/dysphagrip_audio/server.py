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

log = logging.getLogger("dysphagrip.audio")
STATIC = Path(__file__).parent / "static"

DEFAULT_ORIGINS = [
    "http://localhost:5173", "http://127.0.0.1:5173",   # Vite dev server
    "http://localhost:3000", "http://127.0.0.1:3000",   # Express (production build)
    "http://localhost:8765", "http://127.0.0.1:8765",   # this service's viewer
]


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
        # Optional in-process listeners (e.g. MonitorHub) receive the same frames as WS clients.
        self._frame_listeners: list = []
        self._latest_frame: dict | None = None

    def add_frame_listener(self, fn) -> Callable[[], None]:
        self._frame_listeners.append(fn)
        return lambda: self._frame_listeners.remove(fn) if fn in self._frame_listeners else None

    @property
    def latest_frame(self) -> dict | None:
        return self._latest_frame

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
                self._latest_frame = frame
                for fn in list(self._frame_listeners):
                    try:
                        fn(frame)
                    except Exception:  # noqa: BLE001
                        pass
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


class ModeRequest(BaseModel):
    mode: str  # live | demo


class ImuConnectRequest(BaseModel):
    transport: str  # serial | tcp
    port: str | None = None
    host: str = "192.168.1.1"
    tcp_port: int = 9001
    baud: int = 115200


class SessionStartRequest(BaseModel):
    label: str | None = None


def create_app(cfg: AudioConfig | None = None, source_factory: SourceFactory | None = None,
               autostart: StartRequest | None = None, allowed_origins: list[str] | None = None,
               device_lister: Callable[[], list[dict]] = list_input_devices) -> FastAPI:
    cfg = cfg or AudioConfig()
    service = AudioService(cfg, source_factory or default_source_factory())
    origins = allowed_origins or DEFAULT_ORIGINS

    from .monitor import MonitorHub
    monitor = MonitorHub(service, cfg)

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        if autostart is not None:
            try:
                await service.start(autostart)
            except Exception as exc:  # noqa: BLE001 -- keep serving so the UI can show the error
                service.last_error = f"Autostart failed: {exc}"
                log.error(service.last_error)
        yield
        if monitor.monitoring:
            await monitor.stop_monitoring(save=False)
        monitor.imu.stop()
        await service.stop()

    app = FastAPI(title="DysphaGrip multimodal service", version="0.2.0", lifespan=lifespan)
    app.state.service = service
    app.state.monitor = monitor
    app.add_middleware(CORSMiddleware, allow_origins=origins,
                       allow_methods=["GET", "POST", "DELETE"],
                       allow_headers=["Content-Type"])

    @app.get("/health")
    async def health():
        return {
            "ok": True,
            "service": "dysphagrip-audio",
            "running": service.running,
            **{k: v for k, v in monitor.health().items() if k not in ("ok", "service")},
        }

    @app.get("/api/health")
    async def api_health():
        return monitor.health()

    @app.get("/devices")
    async def devices():
        try:
            devs = await asyncio.to_thread(device_lister)
        except Exception as exc:  # noqa: BLE001 -- e.g. PortAudio missing
            raise HTTPException(503, f"Could not query audio devices: {exc}") from exc
        from .devices import find_um2, find_usb_audio_interface
        um2 = find_um2(devs)
        usb = find_usb_audio_interface(devs)
        return {
            "devices": devs,
            "um2_candidate": um2["index"] if um2 else None,
            "usb_audio_candidate": usb["index"] if usb else None,
        }

    @app.get("/api/devices")
    async def api_devices():
        try:
            devs = await asyncio.to_thread(device_lister)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(503, f"Could not query audio devices: {exc}") from exc
        from .devices import find_um2, find_usb_audio_interface
        um2 = find_um2(devs)
        usb = find_usb_audio_interface(devs)
        return monitor.devices_bundle(
            devs,
            um2["index"] if um2 else None,
            usb["index"] if usb else None,
        )

    @app.get("/status")
    async def status():
        return {**service.status(), "monitor": monitor.live_snapshot()}

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

    @app.post("/api/mode")
    async def set_mode(req: ModeRequest):
        try:
            return await monitor.set_mode(req.mode)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc

    @app.post("/api/imu/connect")
    async def imu_connect(req: ImuConnectRequest):
        try:
            return await monitor.connect_imu(
                transport=req.transport, port=req.port, host=req.host,
                tcp_port=req.tcp_port, baud=req.baud,
            )
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc

    @app.post("/api/imu/disconnect")
    async def imu_disconnect():
        return await monitor.disconnect_imu()

    @app.post("/api/sessions/start")
    async def sessions_start(req: SessionStartRequest = SessionStartRequest()):
        try:
            return await monitor.start_monitoring(label=req.label)
        except RuntimeError as exc:
            raise HTTPException(400, str(exc)) from exc

    @app.post("/api/sessions/stop")
    async def sessions_stop():
        return await monitor.stop_monitoring(save=True)

    @app.post("/api/sessions/reset")
    async def sessions_reset():
        return await monitor.reset_session()

    @app.post("/api/calibration")
    async def calibration_start():
        return await monitor.start_calibration()

    @app.get("/api/calibration")
    async def calibration_status():
        return monitor.calibrator.progress()

    @app.get("/api/sessions")
    async def sessions_list():
        return {"sessions": monitor.store.list()}

    @app.get("/api/sessions/{session_id}")
    async def sessions_get(session_id: str):
        row = monitor.store.get(session_id)
        if not row:
            raise HTTPException(404, "Session not found")
        return row

    @app.get("/api/sessions/{session_id}/export")
    async def sessions_export(session_id: str, format: str = "json"):
        from fastapi.responses import Response
        exported = monitor.store.export(session_id, fmt=format)
        if not exported:
            raise HTTPException(404, "Session not found")
        body, media = exported
        ext = "csv" if format == "csv" else "json"
        return Response(
            content=body,
            media_type=media,
            headers={"Content-Disposition": f'attachment; filename="dysphagrip-{session_id}.{ext}"'},
        )

    @app.delete("/api/sessions/{session_id}")
    async def sessions_delete(session_id: str):
        if not monitor.store.delete(session_id):
            raise HTTPException(404, "Session not found")
        return {"ok": True}

    @app.websocket("/stream")
    async def stream(ws: WebSocket):
        origin = ws.headers.get("origin")
        if origin and origin not in origins:
            await ws.close(code=1008)
            return
        await ws.accept()
        service.clients.add(ws)
        await ws.send_text(json.dumps({"type": "hello", **service.status()}))
        try:
            while True:
                await ws.receive_text()   # clients don't need to send; this detects disconnect
        except WebSocketDisconnect:
            pass
        finally:
            service.clients.discard(ws)

    @app.websocket("/ws/live")
    async def ws_live(ws: WebSocket):
        origin = ws.headers.get("origin")
        if origin and origin not in origins:
            await ws.close(code=1008)
            return
        await ws.accept()
        monitor.clients.add(ws)
        await ws.send_text(json.dumps({
            "type": "hello",
            **monitor.health(),
            "session": monitor.live_snapshot(),
        }, separators=(",", ":")))
        try:
            while True:
                await ws.receive_text()
        except WebSocketDisconnect:
            pass
        finally:
            monitor.clients.discard(ws)

    @app.get("/")
    async def viewer():
        return FileResponse(STATIC / "index.html")

    return app
