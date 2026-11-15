"""MPU-6050 acquisition adapters for Arduino UNO Q.

Supported transports (honest reporting — never claims connected without data):

1. **Serial** — newline-delimited JSON on a USB serial port if the UNO Q exposes one
   that macOS can open (not assumed; many App Lab sketches stay on the Linux side).
2. **TCP** — a small Linux-side streamer on the UNO Q Qualcomm processor that forwards
   MCU Bridge readings to the Mac over the local network (preferred reliable path).
3. **None** — disconnected; status reports ``disconnected`` with a clear reason.

Expected line format (firmware contract)::

    {"type":"imu","seq":12,"t_ms":1234,"ax":0.01,"ay":0.02,"az":0.98,"gx":1.2,"gy":-0.3,"gz":0.1}

Timestamps ``t_ms`` are board-relative milliseconds. The host stamps ``host_unix_ms`` on arrival.
"""
from __future__ import annotations

import json
import logging
import socket
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Callable

log = logging.getLogger("dysphagrip.imu")

MAX_BUFFER = 2000  # ~20 s at 100 Hz


@dataclass
class ImuSample:
    seq: int
    board_t_ms: float | None
    host_unix_ms: float
    ax: float
    ay: float
    az: float
    gx: float
    gy: float
    gz: float
    accel_mag: float
    gyro_mag: float

    def to_dict(self) -> dict:
        return {
            "type": "imu_sample",
            "seq": self.seq,
            "board_t_ms": self.board_t_ms,
            "host_unix_ms": round(self.host_unix_ms, 3),
            "ax": round(self.ax, 5),
            "ay": round(self.ay, 5),
            "az": round(self.az, 5),
            "gx": round(self.gx, 4),
            "gy": round(self.gy, 4),
            "gz": round(self.gz, 4),
            "accel_mag": round(self.accel_mag, 5),
            "gyro_mag": round(self.gyro_mag, 4),
        }


@dataclass
class ImuStatus:
    state: str  # disconnected | connecting | connected | stale | error
    transport: str | None = None  # serial | tcp | demo | None
    endpoint: str | None = None
    last_error: str | None = None
    samples_received: int = 0
    last_host_unix_ms: float | None = None
    sensor_ok: bool | None = None

    def to_dict(self) -> dict:
        freshness_ms = None
        if self.last_host_unix_ms is not None:
            freshness_ms = round(time.time() * 1000 - self.last_host_unix_ms, 1)
        return {
            "state": self.state,
            "transport": self.transport,
            "endpoint": self.endpoint,
            "last_error": self.last_error,
            "samples_received": self.samples_received,
            "last_host_unix_ms": self.last_host_unix_ms,
            "freshness_ms": freshness_ms,
            "sensor_ok": self.sensor_ok,
        }


def parse_imu_line(line: str, host_unix_ms: float | None = None) -> ImuSample | None:
    """Parse one NDJSON line from firmware. Returns None if not an IMU payload."""
    line = line.strip()
    if not line or line[0] != "{":
        return None
    try:
        obj = json.loads(line)
    except json.JSONDecodeError:
        return None
    if not isinstance(obj, dict):
        return None
    kind = obj.get("type")
    if kind not in ("imu", "motion", "imu_sample"):
        return None
    try:
        ax = float(obj["ax"])
        ay = float(obj["ay"])
        az = float(obj["az"])
        gx = float(obj.get("gx", 0.0))
        gy = float(obj.get("gy", 0.0))
        gz = float(obj.get("gz", 0.0))
    except (KeyError, TypeError, ValueError):
        return None
    accel_mag = (ax * ax + ay * ay + az * az) ** 0.5
    gyro_mag = (gx * gx + gy * gy + gz * gz) ** 0.5
    board_t = obj.get("t_ms", obj.get("timestamp_ms"))
    try:
        board_t_ms = float(board_t) if board_t is not None else None
    except (TypeError, ValueError):
        board_t_ms = None
    seq = int(obj.get("seq", 0))
    return ImuSample(
        seq=seq,
        board_t_ms=board_t_ms,
        host_unix_ms=host_unix_ms if host_unix_ms is not None else time.time() * 1000,
        ax=ax, ay=ay, az=az, gx=gx, gy=gy, gz=gz,
        accel_mag=accel_mag, gyro_mag=gyro_mag,
    )


def list_serial_ports() -> list[dict]:
    """Enumerate serial ports. Empty list if pyserial is missing or none found."""
    try:
        from serial.tools import list_ports
    except ImportError:
        return []
    out = []
    for p in list_ports.comports():
        out.append({
            "device": p.device,
            "description": p.description or "",
            "hwid": p.hwid or "",
            "manufacturer": getattr(p, "manufacturer", None) or "",
        })
    return out


class ImuReceiver:
    """Background reader that fills a bounded sample buffer and exposes connection status."""

    STALE_MS = 1500.0

    def __init__(self):
        self._lock = threading.Lock()
        self._buffer: deque[ImuSample] = deque(maxlen=MAX_BUFFER)
        self._status = ImuStatus(state="disconnected")
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._listeners: list[Callable[[ImuSample], None]] = []

    @property
    def status(self) -> ImuStatus:
        with self._lock:
            st = ImuStatus(**{**self._status.__dict__})
        if st.state == "connected" and st.last_host_unix_ms is not None:
            age = time.time() * 1000 - st.last_host_unix_ms
            if age > self.STALE_MS:
                st.state = "stale"
        return st

    def subscribe(self, fn: Callable[[ImuSample], None]) -> Callable[[], None]:
        self._listeners.append(fn)
        return lambda: self._listeners.remove(fn) if fn in self._listeners else None

    def latest(self, n: int = 1) -> list[ImuSample]:
        with self._lock:
            if n <= 1:
                return [self._buffer[-1]] if self._buffer else []
            items = list(self._buffer)
            return items[-n:]

    def drain_since(self, after_host_ms: float | None) -> list[ImuSample]:
        with self._lock:
            if after_host_ms is None:
                return list(self._buffer)
            return [s for s in self._buffer if s.host_unix_ms > after_host_ms]

    def _push(self, sample: ImuSample) -> None:
        with self._lock:
            self._buffer.append(sample)
            self._status.samples_received += 1
            self._status.last_host_unix_ms = sample.host_unix_ms
            self._status.state = "connected"
            self._status.sensor_ok = True
            self._status.last_error = None
        for fn in list(self._listeners):
            try:
                fn(sample)
            except Exception as exc:  # noqa: BLE001
                log.warning("imu listener error: %s", exc)

    def _set_error(self, message: str) -> None:
        with self._lock:
            self._status.state = "error"
            self._status.last_error = message
            self._status.sensor_ok = False

    def stop(self) -> None:
        self._stop.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=2.0)
        self._thread = None
        with self._lock:
            if self._status.state not in ("error",):
                self._status.state = "disconnected"
            self._status.transport = None
            self._status.endpoint = None

    def start_serial(self, port: str, baud: int = 115200) -> None:
        self.stop()
        self._stop.clear()
        with self._lock:
            self._status = ImuStatus(state="connecting", transport="serial", endpoint=f"{port}@{baud}")
        self._thread = threading.Thread(target=self._serial_loop, args=(port, baud), daemon=True)
        self._thread.start()

    def start_tcp(self, host: str, port: int) -> None:
        self.stop()
        self._stop.clear()
        endpoint = f"{host}:{port}"
        with self._lock:
            self._status = ImuStatus(state="connecting", transport="tcp", endpoint=endpoint)
        self._thread = threading.Thread(target=self._tcp_loop, args=(host, port), daemon=True)
        self._thread.start()

    def inject(self, sample: ImuSample) -> None:
        """Used by demo mode — marks transport as demo."""
        with self._lock:
            self._status.transport = self._status.transport or "demo"
            if self._status.state == "disconnected":
                self._status.state = "connected"
                self._status.endpoint = "simulated"
        self._push(sample)

    def _serial_loop(self, port: str, baud: int) -> None:
        try:
            import serial
        except ImportError:
            self._set_error("pyserial is not installed. Run: pip install pyserial")
            return
        try:
            ser = serial.Serial(port, baud, timeout=0.2)
        except Exception as exc:  # noqa: BLE001
            self._set_error(f"Could not open serial port {port}: {exc}")
            return
        with self._lock:
            self._status.state = "connected"
        buf = ""
        try:
            while not self._stop.is_set():
                raw = ser.read(256)
                if not raw:
                    continue
                buf += raw.decode("utf-8", errors="ignore")
                while "\n" in buf:
                    line, buf = buf.split("\n", 1)
                    sample = parse_imu_line(line)
                    if sample:
                        self._push(sample)
                    elif line.strip().startswith("{") and '"error"' in line:
                        try:
                            err = json.loads(line)
                            self._set_error(str(err.get("error") or err.get("message") or line))
                        except json.JSONDecodeError:
                            pass
        except Exception as exc:  # noqa: BLE001
            self._set_error(f"Serial IMU read failed: {exc}")
        finally:
            try:
                ser.close()
            except Exception:  # noqa: BLE001
                pass

    def _tcp_loop(self, host: str, port: int) -> None:
        sock: socket.socket | None = None
        try:
            sock = socket.create_connection((host, port), timeout=3.0)
            sock.settimeout(0.5)
        except Exception as exc:  # noqa: BLE001
            self._set_error(
                f"Could not connect to UNO Q IMU streamer at {host}:{port}: {exc}. "
                "Run hardware/unoq_mpu6050/linux_streamer.py on the board's Linux side."
            )
            return
        with self._lock:
            self._status.state = "connected"
        buf = ""
        try:
            while not self._stop.is_set():
                try:
                    chunk = sock.recv(1024)
                except socket.timeout:
                    continue
                if not chunk:
                    self._set_error("UNO Q IMU TCP stream closed.")
                    break
                buf += chunk.decode("utf-8", errors="ignore")
                while "\n" in buf:
                    line, buf = buf.split("\n", 1)
                    sample = parse_imu_line(line)
                    if sample:
                        self._push(sample)
        except Exception as exc:  # noqa: BLE001
            self._set_error(f"TCP IMU read failed: {exc}")
        finally:
            try:
                if sock:
                    sock.close()
            except Exception:  # noqa: BLE001
                pass


@dataclass
class ImuFeatures:
    accel_mag: float
    gyro_mag: float
    motion_energy: float
    movement_variability: float
    above_baseline: bool

    def to_dict(self) -> dict:
        return {
            "accel_mag": round(self.accel_mag, 5),
            "gyro_mag": round(self.gyro_mag, 4),
            "motion_energy": round(self.motion_energy, 5),
            "movement_variability": round(self.movement_variability, 5),
            "above_baseline": self.above_baseline,
        }


def compute_imu_features(samples: list[ImuSample], baseline_accel: float = 1.0,
                         motion_threshold: float = 0.15) -> ImuFeatures | None:
    if not samples:
        return None
    mags = [s.accel_mag for s in samples]
    gyros = [s.gyro_mag for s in samples]
    accel_mag = float(sum(mags) / len(mags))
    gyro_mag = float(sum(gyros) / len(gyros))
    # Deviation from ~1 g resting magnitude + gyro activity
    deviations = [abs(m - baseline_accel) for m in mags]
    motion_energy = float(sum(deviations) / len(deviations)) + 0.01 * gyro_mag
    mean_m = accel_mag
    variability = float((sum((m - mean_m) ** 2 for m in mags) / len(mags)) ** 0.5)
    return ImuFeatures(
        accel_mag=accel_mag,
        gyro_mag=gyro_mag,
        motion_energy=motion_energy,
        movement_variability=variability,
        above_baseline=motion_energy >= motion_threshold,
    )
