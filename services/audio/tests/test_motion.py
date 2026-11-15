"""Motion pipeline tests. Firmware output is simulated by TEST-ONLY generators below; nothing here is wired
into the runtime. The TCP test uses a real local socket and the real TcpLineSource."""
import json
import socket
import threading
import time

import pytest
from fastapi.testclient import TestClient

from dysphagrip_audio.config import AudioConfig
from dysphagrip_audio.motion import (
    ClockSync, MotionConfig, MotionStream, MovementDetector, LineSource, parse_line, parse_source_spec,
)
from dysphagrip_audio.server import create_app


def imu(seq, t_ms, ax=0.0, ay=0.0, az=1.0, gx=0.0, gy=0.0, gz=0.0):
    """One line in the exact format the firmware prints."""
    return (f'{{"type":"imu","seq":{seq},"t_ms":{t_ms},"ax":{ax:.4f},"ay":{ay:.4f},"az":{az:.4f},'
            f'"gx":{gx:.3f},"gy":{gy:.3f},"gz":{gz:.3f},"temp_c":29.40}}\n').encode()


HELLO = b'{"type":"hello","device":"mpu6050","fw":"0.1.0","addr":"0x68","whoami":"0x68","rate_hz":100,"accel_range_g":2,"gyro_range_dps":250}\n'


# ---------------------------------------------------------------- parsing

def test_parse_valid_and_invalid_lines():
    m = parse_line(imu(3, 1234, ax=0.5, gz=-12.5))
    assert m["type"] == "imu" and m["seq"] == 3 and m["t_ms"] == 1234 and m["ax"] == 0.5 and m["gz"] == -12.5
    assert parse_line(HELLO)["whoami"] == "0x68"
    assert parse_line(b'{"type":"error","msg":"MPU-6050 not found"}')["msg"].startswith("MPU")
    for bad in (b"", b"garbage", b"{not json", b'{"type":"imu","seq":1}', b'{"type":"imu","seq":1,"t_ms":2,"ax":"nan"}',
                b'{"type":"other"}', b"[1,2,3]", b'{"type":"imu","seq":1,"t_ms":1,"ax":NaN,"ay":0,"az":0,"gx":0,"gy":0,"gz":0}'):
        assert parse_line(bad) is None, bad


def test_source_spec_parsing():
    assert parse_source_spec("serial:COM5") == ("serial", {"port": "COM5"})
    assert parse_source_spec("/dev/cu.usbmodem101") == ("serial", {"port": "/dev/cu.usbmodem101"})
    assert parse_source_spec("tcp://192.168.1.20:7070") == ("tcp", {"host": "192.168.1.20", "port": 7070})
    with pytest.raises(ValueError):
        parse_source_spec("tcp://nohost")


# ---------------------------------------------------------------- clock sync

def test_clock_sync_uses_minimum_latency_and_reports_jitter():
    cs = ClockSync()
    true_offset = 1_800_000_000_000.0          # host_ms - board_ms
    latencies = [4, 9, 2, 15, 3, 2, 7, 30, 2, 5] * 10   # transport delay per sample (ms)
    for i, lat in enumerate(latencies):
        board = i * 10.0
        cs.observe(board, board + true_offset + lat)
    assert cs.offset_ms == pytest.approx(true_offset + 2)     # minimum latency = constant 2 ms error
    assert cs.to_host_ms(500.0) == pytest.approx(500.0 + true_offset + 2)
    st = cs.stats()
    assert st["jitter_p95_ms"] >= 10 and st["window_samples"] == 100


def test_clock_sync_measures_drift_and_handles_board_reboot():
    cs = ClockSync(window_s=60)
    for i in range(0, 4001):                    # 40 s at 100 Hz; host clock runs 100 ppm faster
        board = i * 10.0
        cs.observe(board, 1e12 + board * (1 + 100e-6) + 2)
    assert cs.stats()["drift_ppm"] == pytest.approx(100, abs=5)
    cs.observe(5.0, 2e12)                       # millis() restarted -> reset
    assert cs.resets == 1 and cs.stats()["window_samples"] == 1


# ---------------------------------------------------------------- detector

def run_detector(det, samples, start=0.0, dt=10.0):
    out = None
    for i, s in enumerate(samples):
        out = det.update(start + i * dt, s)
    return out


def test_still_sensor_is_not_interference():
    det = MovementDetector()
    still = [dict(ax=0.0, ay=0.0, az=1.0, gx=0.3, gy=-0.2, gz=0.1)] * 300
    out = run_detector(det, still)
    assert out["interference"] is False and out["movement_score"] < 0.2


def test_head_turn_triggers_with_hysteresis():
    cfg = MotionConfig()
    det = MovementDetector(cfg)
    run_detector(det, [dict(ax=0, ay=0, az=1, gx=0, gy=0, gz=0)] * 100)
    turn = [dict(ax=0.0, ay=0.0, az=1.0, gx=0.0, gy=60.0, gz=10.0)] * 10        # 100 ms: shorter than on_ms
    assert run_detector(det, turn, start=1000)["interference"] is False
    turn = [dict(ax=0.0, ay=0.0, az=1.0, gx=0.0, gy=60.0, gz=10.0)] * 40        # 400 ms
    assert run_detector(det, turn, start=1100)["interference"] is True
    calm = [dict(ax=0, ay=0, az=1, gx=0, gy=0, gz=0)]
    assert run_detector(det, calm * 40, start=1500)["interference"] is True     # still inside off_ms
    assert run_detector(det, calm * 60, start=1900)["interference"] is False


def test_static_tilt_is_not_movement_but_bumps_are():
    det = MovementDetector()
    tilted = [dict(ax=0.5, ay=0.0, az=0.866, gx=0, gy=0, gz=0)] * 400           # 30° tilt, still
    assert run_detector(det, tilted)["accel_dyn_rms_g"] < 0.01
    bumps = [dict(ax=0.5 + (0.3 if i % 2 else -0.3), ay=0, az=0.866, gx=0, gy=0, gz=0) for i in range(40)]
    assert run_detector(det, bumps, start=4000)["interference"] is True


# ---------------------------------------------------------------- stream (fake transport)

class FakeSource(LineSource):
    kind = "fake"

    def __init__(self, on_line):
        super().__init__(on_line)
        self.started = False

    def describe(self):
        return "fake"

    def start(self):
        self.started = True
        self.connected = True

    def stop(self):
        self.started = False
        self.connected = False


def make_stream():
    holder = {}

    def factory(kind, params, on_line):
        holder["src"] = FakeSource(on_line)
        return holder["src"]
    s = MotionStream("serial:FAKE", source_factory=factory)
    return s, holder["src"]


def test_stream_parses_syncs_and_counts_gaps():
    s, src = make_stream()
    s.start()
    now = time.time_ns()
    src.on_line(HELLO, now)
    for i, seq in enumerate([0, 1, 2, 5, 6]):                 # seq 3,4 lost
        src.on_line(imu(seq, 1000 + seq * 10), now + int((seq * 10 + 3) * 1e6))
    src.on_line(b"noise\n", now)
    src.on_line(b'{"type":"error","msg":"I2C read failed"}\n', now)
    frame = s.drain_frame()
    assert frame["type"] == "motion_frame" and len(frame["samples"]) == 5
    assert frame["samples"][0]["t_unix_ms"] == pytest.approx(now / 1e6 + 3, abs=0.01)
    st = s.status()
    assert st["device"]["whoami"] == "0x68" and st["seq_gaps"] == 2 and st["parse_errors"] == 1
    assert st["device_errors"] == ["I2C read failed"] and st["receiving"] is True
    assert s.drain_frame() is None


# ---------------------------------------------------------------- real TCP transport end-to-end

def test_tcp_relay_end_to_end():
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.bind(("127.0.0.1", 0))
    server.listen(1)
    port = server.getsockname()[1]

    def relay():  # TEST-ONLY stand-in for hardware/unoq_mpu6050/relay/serial_to_tcp.py
        conn, _ = server.accept()
        conn.sendall(HELLO)
        for seq in range(50):
            conn.sendall(imu(seq, 500 + seq * 10, gy=80.0 if seq >= 20 else 0.0))
            time.sleep(0.01)
        time.sleep(0.5)
        conn.close()

    t = threading.Thread(target=relay, daemon=True)
    t.start()
    s = MotionStream(f"tcp://127.0.0.1:{port}")
    s.start()
    deadline = time.time() + 5
    got = []
    while time.time() < deadline and len(got) < 50:
        f = s.drain_frame()
        if f:
            got.extend(f["samples"])
            last_features = f["features"]
        time.sleep(0.05)
    s.stop()
    server.close()
    assert len(got) == 50
    assert s.device["device"] == "mpu6050"
    assert last_features["interference"] is True                  # 300 ms of 80 °/s rotation
    ts = [x["t_unix_ms"] for x in got]
    assert all(b > a for a, b in zip(ts, ts[1:]))                 # monotonic host-mapped timestamps


# ---------------------------------------------------------------- HTTP / WebSocket integration

def test_motion_endpoints_and_websocket_frames():
    holder = {}

    def factory(spec):
        if spec == "missing":
            raise LookupError("No Arduino-like serial port found")
        if spec.startswith("tcp://bad"):
            raise ValueError("TCP source must look like tcp://HOST:PORT")
        s, src = make_stream()
        holder["src"] = src
        return s

    app = create_app(AudioConfig(hop_ms=20), source_factory=lambda r, c: None, device_lister=lambda: [],
                     motion_factory=factory,
                     port_lister=lambda: [{"device": "COM7", "description": "Arduino UNO Q", "likely_arduino": True}])
    with TestClient(app) as c:
        assert c.get("/motion/ports").json()["ports"][0]["device"] == "COM7"
        assert c.post("/motion/start", json={"source": "missing"}).status_code == 404
        assert c.post("/motion/start", json={"source": "tcp://bad"}).status_code == 400
        with c.websocket_connect("/stream") as ws:
            hello = ws.receive_json()
            assert hello["type"] == "hello" and hello["motion"]["running"] is False
            assert c.post("/motion/start", json={"source": "serial:COM7"}).json()["running"] is True
            now = time.time_ns()
            holder["src"].on_line(HELLO, now)
            for seq in range(10):
                holder["src"].on_line(imu(seq, seq * 10), now + seq * 10_000_000)
            seen = set()
            frame = None
            for _ in range(40):
                m = ws.receive_json()
                seen.add(m["type"])
                if m["type"] == "motion_frame":
                    frame = m
                    break
            assert "motion_status" in seen and frame is not None
            assert len(frame["samples"]) == 10 and "movement_score" in frame["features"]
        assert c.post("/motion/stop").json()["running"] is False
        assert c.get("/health").json()["motion_running"] is False
