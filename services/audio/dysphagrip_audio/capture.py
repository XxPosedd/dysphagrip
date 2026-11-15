"""Audio sources: live device capture (sounddevice) and labelled WAV-file playback.

Timestamp model
---------------
Each source records an *anchor*: the host wall-clock time (Unix ns) of sample 0.
Sample n is then timestamped as anchor + n / fs. This keeps audio timestamps
locked to the audio sample clock (no per-block jitter). The audio clock and the
host clock drift relative to each other (typically tens of ppm); the source
reports `wall_minus_sample_clock_ms` so drift is visible rather than hidden.
"""
from __future__ import annotations

import threading
import time
from pathlib import Path

import numpy as np


class RingBuffer:
    """Thread-safe float32 ring buffer indexed by absolute sample number."""

    def __init__(self, capacity: int):
        if capacity <= 0:
            raise ValueError("capacity must be positive")
        self._buf = np.zeros(capacity, dtype=np.float32)
        self._cap = capacity
        self._total = 0
        self._lock = threading.Lock()

    @property
    def capacity(self) -> int:
        return self._cap

    @property
    def total_written(self) -> int:
        with self._lock:
            return self._total

    def write(self, x: np.ndarray) -> None:
        x = np.asarray(x, dtype=np.float32).ravel()
        n = x.size
        if n == 0:
            return
        with self._lock:
            if n > self._cap:          # only the newest `cap` samples survive
                self._total += n - self._cap
                x = x[-self._cap:]
                n = self._cap
            start = self._total % self._cap
            first = min(n, self._cap - start)
            self._buf[start:start + first] = x[:first]
            self._buf[:n - first] = x[first:]
            self._total += n

    def read_since(self, pos: int) -> tuple[np.ndarray, int, int]:
        """Samples written at absolute index >= pos.

        Returns (samples, start_index, dropped) where dropped counts samples that
        were overwritten before the reader got to them.
        """
        with self._lock:
            total = self._total
            oldest = max(0, total - self._cap)
            dropped = max(0, oldest - pos)
            pos = max(pos, oldest)
            n = total - pos
            out = np.empty(n, dtype=np.float32)
            if n:
                start = pos % self._cap
                first = min(n, self._cap - start)
                out[:first] = self._buf[start:start + first]
                out[first:] = self._buf[:n - first]
            return out, pos, dropped


class _BaseSource:
    kind = "base"

    def __init__(self, fs: float, buffer_seconds: float):
        self.fs = float(fs)
        self.buffer = RingBuffer(max(1, int(self.fs * buffer_seconds)))
        self.anchor_unix_ns: int | None = None
        self.anchor_method: str | None = None
        self._last_arrival_ns: int | None = None

    def sample_time_unix_ms(self, index: int) -> float | None:
        if self.anchor_unix_ns is None:
            return None
        return self.anchor_unix_ns / 1e6 + index * 1000.0 / self.fs

    def wall_minus_sample_clock_ms(self) -> float | None:
        """Wall-clock elapsed minus sample-count elapsed at the latest block (includes block jitter)."""
        if self.anchor_unix_ns is None or self._last_arrival_ns is None:
            return None
        wall = (self._last_arrival_ns - self.anchor_unix_ns) / 1e6
        samples = self.buffer.total_written * 1000.0 / self.fs
        return round(wall - samples, 2)

    @property
    def active(self) -> bool:
        raise NotImplementedError

    def info(self) -> dict:
        return {
            "kind": self.kind,
            "samplerate": self.fs,
            "anchor_unix_ms": None if self.anchor_unix_ns is None else self.anchor_unix_ns / 1e6,
            "anchor_method": self.anchor_method,
            "samples_captured": self.buffer.total_written,
            "wall_minus_sample_clock_ms": self.wall_minus_sample_clock_ms(),
        }


class DeviceSource(_BaseSource):
    """Live capture from one channel of a PortAudio input device.

    For the Behringer UM2, input 1 (XLR/TRS combo) and input 2 (1/4" instrument,
    Hi-Z) arrive as two channels of one stream. `channel` is 0-based.
    """

    kind = "device"

    def __init__(self, device: dict, channel: int = 0, samplerate: float | None = None,
                 buffer_seconds: float = 10.0, blocksize: int = 0):
        if channel < 0 or channel >= device["max_input_channels"]:
            raise ValueError(f"Channel {channel} out of range: '{device['name']}' has "
                             f"{device['max_input_channels']} input channel(s) (0-based).")
        super().__init__(samplerate or device["default_samplerate"], buffer_seconds)
        self.device = device
        self.channel = channel
        self.n_channels = channel + 1
        self.blocksize = blocksize
        self.overflows = 0
        self._stream = None

    def _callback(self, indata, frames, time_info, status) -> None:  # PortAudio thread
        now = time.time_ns()
        if status and status.input_overflow:
            self.overflows += 1
        if self.anchor_unix_ns is None:
            latency = None
            try:
                latency = float(time_info.currentTime - time_info.inputBufferAdcTime)
            except (AttributeError, TypeError):
                pass
            if latency is not None and 0.0 < latency < 1.0:
                self.anchor_unix_ns = now - int(latency * 1e9)
                self.anchor_method = "portaudio_adc_time"
            else:  # some host APIs (e.g. Windows MME) report zero ADC times
                self.anchor_unix_ns = now - int(frames / self.fs * 1e9)
                self.anchor_method = "callback_arrival_minus_block"
        self.buffer.write(indata[:, self.channel])
        self._last_arrival_ns = now

    def start(self) -> None:
        import sounddevice as sd
        sd.check_input_settings(device=self.device["index"], channels=self.n_channels,
                                samplerate=self.fs, dtype="float32")
        self._stream = sd.InputStream(device=self.device["index"], channels=self.n_channels,
                                      samplerate=self.fs, dtype="float32", blocksize=self.blocksize,
                                      latency="low", callback=self._callback)
        self._stream.start()

    def stop(self) -> None:
        if self._stream is not None:
            try:
                self._stream.stop()
                self._stream.close()
            finally:
                self._stream = None

    @property
    def active(self) -> bool:
        return bool(self._stream is not None and self._stream.active)

    def info(self) -> dict:
        d = super().info()
        d.update({"device_index": self.device["index"], "device_name": self.device["name"],
                  "hostapi": self.device.get("hostapi"), "channel": self.channel,
                  "um2_match": self.device.get("um2_match"), "overflows": self.overflows})
        return d


def load_wav_mono(path: str | Path, channel: int = 0) -> tuple[float, np.ndarray]:
    from scipy.io import wavfile
    fs, data = wavfile.read(str(path))
    if data.dtype == np.int16:
        x = data.astype(np.float32) / 32768.0
    elif data.dtype == np.int32:
        x = data.astype(np.float32) / 2147483648.0
    elif data.dtype == np.uint8:
        x = (data.astype(np.float32) - 128.0) / 128.0
    else:
        x = data.astype(np.float32)
    if x.ndim == 2:
        if channel >= x.shape[1]:
            raise ValueError(f"WAV has {x.shape[1]} channel(s); channel {channel} requested.")
        x = x[:, channel]
    return float(fs), x


class WavFileSource(_BaseSource):
    """Replays a WAV file at real-time pace. Always labelled source kind 'file' -- never 'device'."""

    kind = "file"

    def __init__(self, path: str | Path, channel: int = 0, loop: bool = True,
                 buffer_seconds: float = 10.0, block_ms: float = 10.0):
        fs, data = load_wav_mono(path, channel)
        if data.size == 0:
            raise ValueError("WAV file is empty.")
        super().__init__(fs, buffer_seconds)
        self.path = Path(path)
        self.data = data
        self.channel = channel
        self.loop = loop
        self.block_s = block_ms / 1000.0
        self._cursor = 0
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()

    def _run(self) -> None:
        self.anchor_unix_ns = time.time_ns()
        self.anchor_method = "file_playback_start"
        written = 0
        while not self._stop.is_set():
            due = int((time.time_ns() - self.anchor_unix_ns) / 1e9 * self.fs)
            n = due - written
            while n > 0:
                take = min(n, self.data.size - self._cursor)
                self.buffer.write(self.data[self._cursor:self._cursor + take])
                self._cursor += take
                written += take
                n -= take
                if self._cursor >= self.data.size:
                    if not self.loop:
                        self._stop.set()
                        break
                    self._cursor = 0
            self._last_arrival_ns = time.time_ns()
            self._stop.wait(self.block_s)

    def start(self) -> None:
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="wav-playback", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=1.0)
            self._thread = None

    @property
    def active(self) -> bool:
        return bool(self._thread is not None and self._thread.is_alive())

    def info(self) -> dict:
        d = super().info()
        d.update({"file": self.path.name, "channel": self.channel, "loop": self.loop})
        return d
