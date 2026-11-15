"""MPU-6050 motion stream: transport (USB serial or TCP), parsing, clock sync and movement-interference detection.

Shared session clock
--------------------
Audio and motion are both timestamped in host Unix time (ms) by THIS process:
  * audio: anchor + sample_index / fs (see capture.py),
  * motion: each board sample's `t_ms` (board millis) is mapped to host time with ClockSync.
ClockSync keeps the MINIMUM observed (host_arrival - board_t) over a sliding window. The minimum is the
sample that waited least in USB/OS buffers, so it is the best estimate of the true offset; mapped times
are therefore free of transport jitter but carry the minimum transport latency as a constant error
(typically 1-5 ms over USB serial, more over Wi-Fi). Jitter and drift between the board crystal and the
host clock are measured and reported, not hidden.

"Movement interference" means the sensor mount moved enough that audio from the same moment is likely
affected by handling/motion artefacts. It is a recording-quality flag, not a physiological measurement.
"""
from __future__ import annotations

import json
import math
import socket
import threading
import time
from collections import deque
from dataclasses import dataclass, asdict
from typing import Callable

IMU_FIELDS = ("ax", "ay", "az", "gx", "gy", "gz")
ARDUINO_VIDS = {0x2341, 0x2A03, 0x1B4F}  # Arduino SA / Arduino.org / SparkFun (hint only)


# --------------------------------------------------------------------------- parsing

def parse_line(raw: bytes | str) -> dict | None:
    """Parse one NDJSON line from the firmware. Returns None for anything malformed."""
    if isinstance(raw, bytes):
        raw = raw.decode("utf-8", errors="replace")
    raw = raw.strip()
    if not raw.startswith("{"):
        return None
    try:
        msg = json.loads(raw)
    except ValueError:
        return None
    if not isinstance(msg, dict):
        return None
    kind = msg.get("type")
    if kind == "imu":
        try:
            out = {"type": "imu", "seq": int(msg["seq"]), "t_ms": float(msg["t_ms"])}
            for k in IMU_FIELDS:
                v = float(msg[k])
                if not math.isfinite(v):
                    return None
                out[k] = v
            if "temp_c" in msg:
                out["temp_c"] = float(msg["temp_c"])
            return out
        except (KeyError, TypeError, ValueError):
            return None
    if kind in ("hello", "error"):
        return msg
    return None


# --------------------------------------------------------------------------- clock sync

class ClockSync:
    """Maps board millis to host Unix ms using the minimum observed offset over a sliding window."""

    def __init__(self, window_s: float = 30.0):
        self.window_ms = window_s * 1000.0
        self._obs: deque[tuple[float, float]] = deque()  # (host_ms, offset_ms)
        self._last_board: float | None = None
        self.resets = 0

    def observe(self, board_ms: float, host_ms: float) -> None:
        if self._last_board is not None and board_ms + 1000 < self._last_board:
            self.reset()                # board rebooted: millis() restarted
            self.resets += 1
        self._last_board = board_ms
        self._obs.append((host_ms, host_ms - board_ms))
        while self._obs and host_ms - self._obs[0][0] > self.window_ms:
            self._obs.popleft()

    def reset(self) -> None:
        self._obs.clear()
        self._last_board = None

    @property
    def offset_ms(self) -> float | None:
        return min(o for _, o in self._obs) if self._obs else None

    def to_host_ms(self, board_ms: float) -> float | None:
        off = self.offset_ms
        return None if off is None else board_ms + off

    def stats(self) -> dict:
        if len(self._obs) < 2:
            return {"offset_ms": self.offset_ms, "jitter_p95_ms": None, "drift_ppm": None, "window_samples": len(self._obs)}
        base = self.offset_ms
        lat = sorted(o - base for _, o in self._obs)
        p95 = lat[min(len(lat) - 1, int(0.95 * len(lat)))]
        # Drift: compare the lower envelope (min offset) of the first and last 20% of the window.
        n = max(1, len(self._obs) // 5)
        obs = list(self._obs)
        first_min = min(obs[:n], key=lambda x: x[1])   # (host_ms, offset_ms) of each envelope point
        last_min = min(obs[-n:], key=lambda x: x[1])
        span_ms = last_min[0] - first_min[0]            # time between the two points actually compared
        drift = None
        if span_ms > 5000:
            drift = round((last_min[1] - first_min[1]) / span_ms * 1e6, 1)
        return {"offset_ms": round(base, 2), "jitter_p95_ms": round(p95, 2), "drift_ppm": drift,
                "window_samples": len(self._obs)}


# --------------------------------------------------------------------------- features / detector

@dataclass(frozen=True)
class MotionConfig:
    """Engineering starting points, not validated thresholds. Calibrate with the real mount."""
    gyro_dps: float = 25.0          # angular-rate RMS above this suggests head/neck movement or handling
    accel_dyn_g: float = 0.06       # dynamic (gravity-removed) acceleration RMS above this suggests movement
    window_ms: float = 200.0        # RMS window
    on_ms: float = 150.0            # condition must hold this long to start an interference episode
    off_ms: float = 400.0           # ...and be absent this long to end it
    baseline_tau_s: float = 1.0     # slow baseline of |a| (removes gravity / static tilt)

    def to_dict(self) -> dict:
        return asdict(self)


class MovementDetector:
    """Rolling RMS of gyro magnitude and dynamic acceleration, with hysteresis."""

    def __init__(self, cfg: MotionConfig | None = None):
        self.cfg = cfg or MotionConfig()
        self._win: deque[tuple[float, float, float]] = deque()  # (t_ms, gyro_mag^2, accel_dyn^2)
        self._baseline: float | None = None
        self._last_t: float | None = None
        self._above_since: float | None = None
        self._below_since: float | None = None
        self.active = False

    def update(self, t_ms: float, s: dict) -> dict:
        amag = math.sqrt(s["ax"] ** 2 + s["ay"] ** 2 + s["az"] ** 2)
        gmag = math.sqrt(s["gx"] ** 2 + s["gy"] ** 2 + s["gz"] ** 2)
        dt = 0.0 if self._last_t is None else max(0.0, (t_ms - self._last_t) / 1000.0)
        self._last_t = t_ms
        if self._baseline is None:
            self._baseline = amag
        else:
            self._baseline += (amag - self._baseline) * min(1.0, dt / self.cfg.baseline_tau_s)
        dyn = amag - self._baseline

        self._win.append((t_ms, gmag * gmag, dyn * dyn))
        while self._win and t_ms - self._win[0][0] > self.cfg.window_ms:
            self._win.popleft()
        n = len(self._win)
        gyro_rms = math.sqrt(sum(w[1] for w in self._win) / n)
        accel_rms = math.sqrt(sum(w[2] for w in self._win) / n)
        score = max(gyro_rms / self.cfg.gyro_dps, accel_rms / self.cfg.accel_dyn_g)

        if score >= 1.0:
            self._below_since = None
            if self._above_since is None:
                self._above_since = t_ms
            if not self.active and t_ms - self._above_since >= self.cfg.on_ms:
                self.active = True
        else:
            self._above_since = None
            if self._below_since is None:
                self._below_since = t_ms
            if self.active and t_ms - self._below_since >= self.cfg.off_ms:
                self.active = False
        return {"accel_mag_g": amag, "accel_dyn_rms_g": accel_rms, "gyro_rms_dps": gyro_rms,
                "movement_score": score, "interference": self.active}


# --------------------------------------------------------------------------- transports

def list_serial_ports() -> list[dict]:
    try:
        from serial.tools import list_ports
    except ImportError:
        return []
    out = []
    for p in list_ports.comports():
        out.append({"device": p.device, "description": p.description or "", "vid": p.vid, "pid": p.pid,
                    "likely_arduino": bool(p.vid in ARDUINO_VIDS or "arduino" in (p.description or "").lower())})
    out.sort(key=lambda d: (not d["likely_arduino"], d["device"]))
    return out


LineCallback = Callable[[bytes, int], None]


class LineSource:
    """Background reader delivering (line, host_arrival_ns). Reconnects automatically."""

    kind = "base"

    def __init__(self, on_line: LineCallback):
        self.on_line = on_line
        self.connected = False
        self.last_error: str | None = None
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def describe(self) -> str:
        raise NotImplementedError

    def _run_once(self) -> None:
        raise NotImplementedError

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                self._run_once()
            except Exception as exc:  # noqa: BLE001 -- surface any transport error and retry
                self.last_error = str(exc)
            self.connected = False
            self._stop.wait(1.0)

    def start(self) -> None:
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name=f"motion-{self.kind}", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._close()
        if self._thread is not None:
            self._thread.join(timeout=2.0)
            self._thread = None

    def _close(self) -> None:
        pass


class SerialLineSource(LineSource):
    kind = "serial"

    def __init__(self, on_line: LineCallback, port: str, baud: int = 115200):
        super().__init__(on_line)
        self.port, self.baud = port, baud
        self._ser = None

    def describe(self) -> str:
        return f"serial:{self.port}@{self.baud}"

    def _run_once(self) -> None:
        import serial
        with serial.Serial(self.port, self.baud, timeout=0.5) as ser:
            self._ser = ser
            self.connected, self.last_error = True, None
            while not self._stop.is_set():
                line = ser.readline()
                if line:
                    self.on_line(line, time.time_ns())

    def _close(self) -> None:
        try:
            if self._ser is not None:
                self._ser.cancel_read()
        except Exception:  # noqa: BLE001
            pass


class TcpLineSource(LineSource):
    kind = "tcp"

    def __init__(self, on_line: LineCallback, host: str, port: int):
        super().__init__(on_line)
        self.host, self.port = host, port
        self._sock: socket.socket | None = None

    def describe(self) -> str:
        return f"tcp://{self.host}:{self.port}"

    def _run_once(self) -> None:
        with socket.create_connection((self.host, self.port), timeout=5) as s:
            self._sock = s
            s.settimeout(0.5)
            s.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            self.connected, self.last_error = True, None
            buf = b""
            while not self._stop.is_set():
                try:
                    chunk = s.recv(4096)
                except socket.timeout:
                    continue
                if not chunk:
                    raise ConnectionError("relay closed the connection")
                now = time.time_ns()
                buf += chunk
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    self.on_line(line, now)

    def _close(self) -> None:
        try:
            if self._sock is not None:
                self._sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass


def parse_source_spec(spec: str) -> tuple[str, dict]:
    """'auto' | 'serial:COM5' | 'serial:/dev/cu.usbmodem101' | 'tcp://192.168.1.20:7070' | bare device path."""
    spec = (spec or "auto").strip()
    if spec == "auto":
        ports = list_serial_ports()
        arduino = [p for p in ports if p["likely_arduino"]]
        if not arduino:
            names = ", ".join(p["device"] for p in ports) or "none"
            raise LookupError(f"No Arduino-like serial port found (ports: {names}). Pick one explicitly.")
        return "serial", {"port": arduino[0]["device"]}
    if spec.startswith("tcp://"):
        hostport = spec[len("tcp://"):]
        host, _, port = hostport.rpartition(":")
        if not host or not port.isdigit():
            raise ValueError("TCP source must look like tcp://HOST:PORT")
        return "tcp", {"host": host, "port": int(port)}
    if spec.startswith("serial:"):
        spec = spec[len("serial:"):]
    if not spec:
        raise ValueError("Empty serial port")
    return "serial", {"port": spec}


# --------------------------------------------------------------------------- service

class MotionStream:
    """Owns one line source; parses, syncs and analyses samples; buffers them for the WebSocket pump."""

    def __init__(self, spec: str, cfg: MotionConfig | None = None,
                 source_factory: Callable[[str, dict, LineCallback], LineSource] | None = None):
        kind, params = parse_source_spec(spec)
        self.spec = spec
        self.sync = ClockSync()
        self.detector = MovementDetector(cfg)
        self.device: dict | None = None
        self.device_errors: deque[str] = deque(maxlen=5)
        self.samples_total = 0
        self.seq_gaps = 0
        self.parse_errors = 0
        self._last_seq: int | None = None
        self._last_t: float | None = None
        self._last_sample_host_ns: int | None = None
        self._pending: list[dict] = []
        self._lock = threading.Lock()
        self.latest: dict | None = None
        factory = source_factory or _default_source_factory
        self.source = factory(kind, params, self._on_line)

    # Called on the reader thread.
    def _on_line(self, line: bytes, host_ns: int) -> None:
        msg = parse_line(line)
        if msg is None:
            if line.strip():
                self.parse_errors += 1
            return
        if msg["type"] == "hello":
            self.device = {k: msg.get(k) for k in ("device", "fw", "addr", "whoami", "rate_hz", "accel_range_g", "gyro_range_dps")}
            self.sync.reset()
            self._last_seq = None
            self._last_t = None
            return
        if msg["type"] == "error":
            self.device_errors.append(str(msg.get("msg", "unknown device error"))[:200])
            return
        host_ms = host_ns / 1e6
        self.sync.observe(msg["t_ms"], host_ms)
        if self._last_seq is not None and msg["seq"] > self._last_seq + 1:
            self.seq_gaps += msg["seq"] - self._last_seq - 1
        self._last_seq = msg["seq"]
        t = self.sync.to_host_ms(msg["t_ms"])
        # When a faster-arriving sample lowers the offset estimate, mapped times shift slightly earlier.
        # Keep the output strictly increasing so the timeline and detector never see time go backwards.
        if self._last_t is not None and t <= self._last_t:
            t = self._last_t + 0.01
        self._last_t = t
        feats = self.detector.update(t, msg)
        sample = {"t_unix_ms": round(t, 2), **{k: round(msg[k], 4) for k in IMU_FIELDS}}
        with self._lock:
            self.samples_total += 1
            self._last_sample_host_ns = host_ns
            self._pending.append(sample)
            if len(self._pending) > 2000:          # nobody draining: keep memory bounded
                del self._pending[:1000]
            self.latest = feats

    def start(self) -> None:
        self.source.start()

    def stop(self) -> None:
        self.source.stop()

    @property
    def receiving(self) -> bool:
        last = self._last_sample_host_ns
        return last is not None and (time.time_ns() - last) < 1.5e9

    def drain_frame(self) -> dict | None:
        """Everything received since the last call, as one motion_frame (None if nothing new)."""
        with self._lock:
            samples, self._pending = self._pending, []
            feats = self.latest
        if not samples:
            return None
        return {
            "type": "motion_frame",
            "samples": samples,
            "features": {k: (round(v, 4) if isinstance(v, float) else v) for k, v in (feats or {}).items()},
        }

    def status(self) -> dict:
        return {
            "source": self.source.describe(),
            "transport": self.source.kind,
            "connected": self.source.connected,
            "receiving": self.receiving,
            "device": self.device,
            "device_errors": list(self.device_errors),
            "last_error": self.source.last_error,
            "samples_total": self.samples_total,
            "seq_gaps": self.seq_gaps,
            "parse_errors": self.parse_errors,
            "sync": {**self.sync.stats(), "board_resets": self.sync.resets},
            "config": self.detector.cfg.to_dict(),
        }


def _default_source_factory(kind: str, params: dict, on_line: LineCallback) -> LineSource:
    if kind == "tcp":
        return TcpLineSource(on_line, params["host"], params["port"])
    return SerialLineSource(on_line, params["port"], params.get("baud", 115200))
