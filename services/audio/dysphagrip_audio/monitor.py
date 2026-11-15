"""Multimodal monitoring hub: audio + IMU + fusion + sessions + demo/live modes."""
from __future__ import annotations

import asyncio
import logging
import time
from collections import deque
from typing import Any

from fastapi import WebSocket

from .calibration import Calibrator
from .config import AudioConfig
from .demo import DemoGenerator
from .fusion import EventDetector, FusionThresholds, classify_idle
from .imu import ImuReceiver, compute_imu_features, list_serial_ports
from .sessions_store import SessionStore

log = logging.getLogger("dysphagrip.monitor")

MAX_EVENTS = 500
MAX_IMU_VIZ = 200


class MonitorHub:
    """Coordinates live or demo multimodal streaming over WebSocket ``/ws/live``."""

    def __init__(self, audio_service, cfg: AudioConfig | None = None,
                 store: SessionStore | None = None):
        self.audio = audio_service
        self.cfg = cfg or AudioConfig()
        self.imu = ImuReceiver()
        self.store = store or SessionStore()
        self.calibrator = Calibrator()
        self.detector = EventDetector()
        self.demo = DemoGenerator(self.cfg)
        self.mode = "live"  # live | demo
        self.clients: set[WebSocket] = set()
        self.session_id: str | None = None
        self.session_started_ms: float | None = None
        self.monitoring = False
        self.events: deque[dict] = deque(maxlen=MAX_EVENTS)
        self.imu_viz: deque[dict] = deque(maxlen=MAX_IMU_VIZ)
        self._task: asyncio.Task | None = None
        self._lock = asyncio.Lock()
        self._last_imu_feat: dict | None = None
        self._quality_hist: list[str] = []
        self.metrics = {
            "swallow_candidates": 0,
            "motion_artifacts": 0,
            "unclassified": 0,
            "frames": 0,
        }
        self.thresholds = FusionThresholds()
        self._audio_queue: asyncio.Queue = asyncio.Queue(maxsize=8)
        self._unsub_audio = None

        def _on_audio(frame: dict) -> None:
            try:
                self._audio_queue.put_nowait(frame)
            except asyncio.QueueFull:
                try:
                    self._audio_queue.get_nowait()
                except asyncio.QueueEmpty:
                    pass
                try:
                    self._audio_queue.put_nowait(frame)
                except asyncio.QueueFull:
                    pass

        self._on_audio = _on_audio
        if hasattr(self.audio, "add_frame_listener"):
            self._unsub_audio = self.audio.add_frame_listener(_on_audio)

    # ---- status helpers ----
    def health(self) -> dict:
        audio_st = self.audio.status()
        imu_st = self.imu.status.to_dict()
        return {
            "ok": True,
            "service": "dysphagrip-monitor",
            "mode": self.mode,
            "monitoring": self.monitoring,
            "session_id": self.session_id,
            "audio": {
                "running": audio_st.get("running"),
                "last_error": audio_st.get("last_error"),
                "source": audio_st.get("source"),
            },
            "imu": imu_st,
            "websocket_clients": len(self.clients),
            "demo_banner_required": self.mode == "demo",
        }

    def devices_bundle(self, audio_devices: list[dict], um2_candidate: int | None,
                       usb_audio_candidate: int | None = None) -> dict:
        return {
            "mode": self.mode,
            "audio": {
                "devices": audio_devices,
                "um2_candidate": um2_candidate,
                "usb_audio_candidate": usb_audio_candidate,
                "running": self.audio.running,
            },
            "imu": {
                "status": self.imu.status.to_dict(),
                "serial_ports": list_serial_ports(),
            },
            "backend_websocket": "open" if self.clients else "idle",
        }

    def live_snapshot(self) -> dict:
        elapsed = 0.0
        if self.session_started_ms is not None:
            elapsed = time.time() * 1000 - self.session_started_ms
        return {
            "type": "session_state",
            "mode": self.mode,
            "monitoring": self.monitoring,
            "session_id": self.session_id,
            "elapsed_ms": round(elapsed, 1),
            "metrics": dict(self.metrics),
            "events_count": len(self.events),
            "calibration": self.calibrator.progress(),
            "demo": self.mode == "demo",
        }

    # ---- mode / imu connect ----
    async def set_mode(self, mode: str) -> dict:
        if mode not in ("live", "demo"):
            raise ValueError("mode must be 'live' or 'demo'")
        async with self._lock:
            was = self.monitoring
            if was:
                await self._stop_monitoring_locked(save=False)
            self.mode = mode
            self.demo.reset()
            self.detector.reset()
            self.events.clear()
            self.imu_viz.clear()
            self.metrics = {k: 0 for k in self.metrics}
            if mode == "demo":
                # Stop any live IMU reader so demo doesn't mix streams
                self.imu.stop()
            if was:
                await self._start_monitoring_locked()
        await self.broadcast(self.live_snapshot())
        await self.broadcast({"type": "mode", "mode": self.mode, "demo": self.mode == "demo"})
        return self.health()

    async def connect_imu(self, *, transport: str, port: str | None = None,
                          host: str = "192.168.1.1", tcp_port: int = 9001,
                          baud: int = 115200) -> dict:
        if self.mode == "demo":
            return {"ok": False, "error": "Switch to Live Mode to connect physical IMU hardware."}
        if transport == "serial":
            if not port:
                raise ValueError("Serial transport requires 'port'.")
            self.imu.start_serial(port, baud)
        elif transport == "tcp":
            self.imu.start_tcp(host, tcp_port)
        else:
            raise ValueError("transport must be 'serial' or 'tcp'")
        await self.broadcast({"type": "device_health", "imu": self.imu.status.to_dict()})
        return self.imu.status.to_dict()

    async def disconnect_imu(self) -> dict:
        self.imu.stop()
        await self.broadcast({"type": "device_health", "imu": self.imu.status.to_dict()})
        return self.imu.status.to_dict()

    # ---- monitoring lifecycle ----
    async def start_monitoring(self, label: str | None = None) -> dict:
        async with self._lock:
            result = await self._start_monitoring_locked(label=label)
        await self.broadcast(self.live_snapshot())
        return result

    async def _start_monitoring_locked(self, label: str | None = None) -> dict:
        if self.monitoring:
            return {"ok": True, "session_id": self.session_id, "already_running": True}
        if self.mode == "live" and not self.audio.running:
            raise RuntimeError(
                "Live Mode requires the audio input to be started first "
                "(POST /start with a USB audio device)."
            )
        self.detector.reset()
        self.detector.thresholds = self.thresholds
        self.events.clear()
        self.imu_viz.clear()
        self.metrics = {k: 0 for k in self.metrics}
        self._quality_hist.clear()
        self.session_started_ms = time.time() * 1000
        audio_src = None
        if self.mode == "demo":
            audio_src = "SIMULATED DEMO DATA"
            self.demo.reset()
        else:
            src = self.audio.status().get("source") or {}
            audio_src = src.get("device_name") or src.get("kind")
        imu_t = "demo" if self.mode == "demo" else self.imu.status.transport
        session = self.store.create_live(
            label=label or f"Session {time.strftime('%H:%M:%S')}",
            mode=self.mode,
            audio_source=audio_src,
            imu_transport=imu_t,
            calibration=self.calibrator.result.to_dict() if self.calibrator.result else None,
        )
        self.session_id = session["id"]
        self.monitoring = True
        self._task = asyncio.create_task(self._pump())
        return {"ok": True, "session_id": self.session_id, "mode": self.mode}

    async def stop_monitoring(self, save: bool = True) -> dict:
        async with self._lock:
            result = await self._stop_monitoring_locked(save=save)
        await self.broadcast(self.live_snapshot())
        return result

    async def _stop_monitoring_locked(self, save: bool = True) -> dict:
        self.monitoring = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
            self._task = None
        saved = None
        if save and self.session_id:
            quality = None
            if self._quality_hist:
                # majority label
                quality = max(set(self._quality_hist), key=self._quality_hist.count)
            saved = self.store.finalize(
                self.session_id,
                events=list(self.events),
                metrics=dict(self.metrics),
                quality_summary=quality,
            )
        sid = self.session_id
        self.session_id = None
        self.session_started_ms = None
        return {"ok": True, "session_id": sid, "saved": saved}

    async def reset_session(self) -> dict:
        async with self._lock:
            if self.monitoring:
                await self._stop_monitoring_locked(save=False)
            self.events.clear()
            self.imu_viz.clear()
            self.metrics = {k: 0 for k in self.metrics}
            self.detector.reset()
            self.demo.reset()
        await self.broadcast(self.live_snapshot())
        return {"ok": True}

    # ---- calibration ----
    async def start_calibration(self) -> dict:
        if self.mode == "live" and not self.audio.running and not self.monitoring:
            result = self.calibrator.fail(
                "No live audio stream. Start USB audio input (or switch to Demo Mode) before calibrating."
            )
            return result.to_dict()
        prog = self.calibrator.start(mode=self.mode)
        await self.broadcast({"type": "calibration", **prog})
        return prog

    def apply_calibration_thresholds(self) -> dict | None:
        r = self.calibrator.result
        if not r or not r.completed:
            return None
        if r.suggested_activity_db is not None:
            self.thresholds.acoustic_activity_db = r.suggested_activity_db
        if r.suggested_motion_artifact is not None:
            self.thresholds.motion_energy_artifact = r.suggested_motion_artifact
            self.thresholds.motion_energy_swallow_max = max(0.1, r.suggested_motion_artifact * 0.75)
        return self.thresholds.__dict__

    # ---- pump ----
    async def _pump(self) -> None:
        hop = self.cfg.hop_ms / 1000.0
        loop = asyncio.get_running_loop()
        deadline = loop.time()
        imu_cursor: float | None = None
        try:
            while self.monitoring:
                deadline += hop
                delay = deadline - loop.time()
                if delay < -hop:
                    deadline = loop.time()
                    delay = 0.0
                await asyncio.sleep(max(0.0, delay))

                frame: dict | None = None
                imu_sample_dict: dict | None = None
                imu_feats: dict | None = None

                if self.mode == "demo":
                    frame = self.demo.next_frame()
                    imu = self.demo.next_imu()
                    imu_sample_dict = imu.to_dict()
                    imu_sample_dict["demo"] = True
                    self.imu_viz.append(imu_sample_dict)
                    from .imu import ImuSample
                    recent = [
                        ImuSample(
                            seq=s["seq"], board_t_ms=s.get("board_t_ms"), host_unix_ms=s["host_unix_ms"],
                            ax=s["ax"], ay=s["ay"], az=s["az"], gx=s["gx"], gy=s["gy"], gz=s["gz"],
                            accel_mag=s["accel_mag"], gyro_mag=s["gyro_mag"],
                        )
                        for s in list(self.imu_viz)[-8:]
                    ]
                    feats = compute_imu_features(recent)
                    imu_feats = feats.to_dict() if feats else None
                    self.imu.inject(imu)
                else:
                    # Live: drain frames produced by AudioService (do not double-process).
                    try:
                        while True:
                            frame = self._audio_queue.get_nowait()
                    except asyncio.QueueEmpty:
                        pass
                    fresh = self.imu.drain_since(imu_cursor)
                    if fresh:
                        imu_cursor = fresh[-1].host_unix_ms
                        for s in fresh:
                            d = s.to_dict()
                            self.imu_viz.append(d)
                        imu_sample_dict = fresh[-1].to_dict()
                        feats = compute_imu_features(list(fresh)[-8:])
                        imu_feats = feats.to_dict() if feats else None

                if frame is None and self.mode == "live":
                    msg: dict[str, Any] = {
                        "type": "tick",
                        "host_unix_ms": time.time() * 1000,
                        "mode": self.mode,
                        "demo": False,
                        "imu": imu_sample_dict,
                        "imu_features": imu_feats,
                        "device_health": {
                            "audio_running": self.audio.running,
                            "imu": self.imu.status.to_dict(),
                        },
                        "session": self.live_snapshot(),
                    }
                    await self.broadcast(msg)
                    continue

                if frame is None:
                    continue

                self.metrics["frames"] += 1
                self._quality_hist.append(frame.get("quality", {}).get("label", "ok"))
                if len(self._quality_hist) > 2000:
                    self._quality_hist = self._quality_hist[-1000:]

                feats_a = frame.get("features") or {}
                t_unix = frame.get("t_end_unix_ms") or time.time() * 1000
                session_t = (t_unix - self.session_started_ms) if self.session_started_ms else 0.0
                motion_e = (imu_feats or {}).get("motion_energy")
                imu_ok = self.mode == "demo" or self.imu.status.state in ("connected", "stale")

                if self.calibrator.running:
                    self.calibrator.ingest_audio(
                        feats_a.get("rms_dbfs", -80),
                        feats_a.get("noise_floor_dbfs", -80),
                    )
                    if imu_feats:
                        self.calibrator.ingest_imu(
                            imu_feats.get("accel_mag", 1.0),
                            imu_feats.get("motion_energy", 0.0),
                        )
                        if self.calibrator.result and self.calibrator.result.completed:
                            self.apply_calibration_thresholds()
                            await self.broadcast({"type": "calibration", **self.calibrator.progress()})

                event = self.detector.update(
                    t_unix_ms=float(t_unix),
                    session_t_ms=float(session_t),
                    acoustic_activity=bool(feats_a.get("activity")),
                    rms_dbfs=float(feats_a.get("rms_dbfs", -80)),
                    snr_db=float(feats_a.get("snr_db", 0)),
                    motion_energy=motion_e,
                    imu_connected=bool(imu_ok),
                )
                event_dict = None
                if event:
                    event_dict = event.to_dict()
                    self.events.append(event_dict)
                    if event.category == "swallow_candidate":
                        self.metrics["swallow_candidates"] += 1
                    elif event.category == "motion_artifact":
                        self.metrics["motion_artifacts"] += 1
                    else:
                        self.metrics["unclassified"] += 1

                self._last_imu_feat = imu_feats
                payload = {
                    "type": "live_frame",
                    "mode": self.mode,
                    "demo": self.mode == "demo",
                    "audio": frame,
                    "imu": imu_sample_dict,
                    "imu_features": imu_feats,
                    "event": event_dict,
                    "activity_state": classify_idle(motion_e, bool(feats_a.get("activity"))),
                    "device_health": {
                        "audio_running": self.mode == "demo" or self.audio.running,
                        "audio_source": frame.get("source"),
                        "imu": self.imu.status.to_dict() if self.mode == "live" else {
                            "state": "connected",
                            "transport": "demo",
                            "endpoint": "simulated",
                            "last_error": None,
                            "samples_received": self.demo.imu_seq,
                            "freshness_ms": 0,
                            "sensor_ok": True,
                        },
                    },
                    "session": self.live_snapshot(),
                }
                await self.broadcast(payload)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            log.exception("monitor pump failed: %s", exc)
            await self.broadcast({"type": "error", "message": f"Monitor pump error: {exc}"})

    async def broadcast(self, message: dict) -> None:
        if not self.clients:
            return
        import json
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
