"""Server tests. The source below is a TEST DOUBLE injected via create_app(); it is
never reachable from the CLI or runtime configuration."""
import time

import numpy as np
from fastapi.testclient import TestClient

from dysphagrip_audio.capture import RingBuffer
from dysphagrip_audio.config import AudioConfig
from dysphagrip_audio.devices import DeviceNotFound
from dysphagrip_audio.server import create_app


class _TestToneSource:
    kind = "test"

    def __init__(self, fs=16000.0):
        self.fs = fs
        self.buffer = RingBuffer(int(fs * 2))
        self.anchor_unix_ns = time.time_ns()
        self._active = False

    def start(self):
        t = np.arange(int(self.fs * 0.5)) / self.fs
        self.buffer.write(0.3 * np.sin(2 * np.pi * 300 * t))
        self._active = True

    def stop(self):
        self._active = False

    @property
    def active(self):
        return self._active

    def sample_time_unix_ms(self, index):
        return self.anchor_unix_ns / 1e6 + index * 1000.0 / self.fs

    def info(self):
        return {"kind": self.kind, "samplerate": self.fs}


def _factory(req, cfg):
    if req.device == "missing":
        raise DeviceNotFound("nope")
    if req.channel > 1:
        raise ValueError("bad channel")
    return _TestToneSource()


FAKE_DEVICES = [{"index": 3, "name": "UM2", "hostapi": "Core Audio", "max_input_channels": 2,
                 "default_samplerate": 48000.0, "is_default": False, "um2_match": "strong"}]


def make_client():
    app = create_app(AudioConfig(hop_ms=20), _factory, device_lister=lambda: FAKE_DEVICES)
    return TestClient(app)


def test_health_and_devices():
    with make_client() as c:
        assert c.get("/health").json() == {"ok": True, "service": "dysphagrip-audio", "running": False}
        body = c.get("/devices").json()
        assert body["um2_candidate"] == 3


def test_start_stop_and_errors():
    with make_client() as c:
        assert c.post("/start", json={"device": "missing"}).status_code == 404
        assert c.post("/start", json={"channel": 5}).status_code == 400
        r = c.post("/start", json={"device": 3, "channel": 1})
        assert r.status_code == 200 and r.json()["running"] is True
        assert c.get("/status").json()["source"]["kind"] == "test"
        # A rejected start must not kill the capture that is already running.
        assert c.post("/start", json={"channel": 5}).status_code == 400
        assert c.get("/status").json()["running"] is True
        assert c.post("/stop").json()["running"] is False


def test_websocket_streams_frames():
    with make_client() as c:
        with c.websocket_connect("/stream") as ws:
            assert ws.receive_json()["type"] == "hello"
            c.post("/start", json={})
            frame = None
            for _ in range(20):
                msg = ws.receive_json()
                if msg["type"] == "audio_frame":
                    frame = msg
                    break
            assert frame is not None
            assert frame["source"] == "test"
            assert abs(frame["features"]["dominant_hz"] - 300) < 16000 / 2048 * 1.5
            assert set(frame["waveform"]) == {"min", "max"}
        c.post("/stop")


def test_websocket_rejects_foreign_origin():
    import pytest
    from starlette.websockets import WebSocketDisconnect
    with make_client() as c:
        with pytest.raises(WebSocketDisconnect):
            with c.websocket_connect("/stream", headers={"origin": "https://evil.example"}) as ws:
                ws.receive_json()


def test_viewer_served():
    with make_client() as c:
        r = c.get("/")
        assert r.status_code == 200 and "DysphaGrip" in r.text
