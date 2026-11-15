"""Deterministic Demo Mode stream — reproducible without hardware.

Always labelled ``source: "demo"`` / transport ``demo``. Never silently substitutes for live.
"""
from __future__ import annotations

import math
import time
from dataclasses import dataclass

import numpy as np

from .config import AudioConfig
from .imu import ImuSample, compute_imu_features
from . import dsp


@dataclass
class DemoScript:
    """Scripted timeline (seconds from start) for a compelling demo loop."""

    period_s: float = 12.0
    swallow_at: tuple[float, ...] = (3.0, 8.5)
    artifact_at: tuple[float, ...] = (5.5,)
    swallow_width_s: float = 0.35
    artifact_width_s: float = 0.55


class DemoGenerator:
    def __init__(self, cfg: AudioConfig | None = None, script: DemoScript | None = None, seed: int = 42):
        self.cfg = cfg or AudioConfig()
        self.script = script or DemoScript()
        self.rng = np.random.default_rng(seed)
        self.fs = 48000.0
        self.seq = 0
        self.imu_seq = 0
        self.t0 = time.time()
        self.sample_pos = 0
        self.noise = dsp.NoiseFloorTracker()
        self.hpf = dsp.StreamingFilter(dsp.design_highpass(self.fs, self.cfg.highpass_hz))
        self.history = np.zeros(0, dtype=np.float64)
        self.keep = max(self.cfg.nfft, int(self.fs * self.cfg.hum_window_s))

    def reset(self) -> None:
        self.t0 = time.time()
        self.seq = 0
        self.imu_seq = 0
        self.sample_pos = 0
        self.noise = dsp.NoiseFloorTracker()
        self.hpf = dsp.StreamingFilter(dsp.design_highpass(self.fs, self.cfg.highpass_hz))
        self.history = np.zeros(0, dtype=np.float64)

    def _phase(self, t: float) -> dict[str, float]:
        p = self.script.period_s
        local = t % p
        swallow = 0.0
        for at in self.script.swallow_at:
            d = abs(local - at)
            if d < self.script.swallow_width_s:
                swallow = max(swallow, math.exp(-((d / (self.script.swallow_width_s * 0.45)) ** 2)))
        artifact = 0.0
        for at in self.script.artifact_at:
            d = abs(local - at)
            if d < self.script.artifact_width_s:
                artifact = max(artifact, math.exp(-((d / (self.script.artifact_width_s * 0.4)) ** 2)))
        return {"swallow": swallow, "artifact": artifact, "local": local}

    def next_audio_block(self, hop_ms: float | None = None) -> tuple[np.ndarray, float]:
        hop_ms = hop_ms or self.cfg.hop_ms
        n = int(self.fs * hop_ms / 1000.0)
        t_start = self.sample_pos / self.fs
        idx = np.arange(n) / self.fs + t_start
        phase = self._phase(t_start + n / (2 * self.fs))
        # Quiet baseline noise floor ~ -55 dBFS
        noise = self.rng.normal(0, 0.0012, size=n)
        # Swallow-like: brief mid-band burst
        swallow_env = phase["swallow"]
        swallow = swallow_env * 0.18 * np.sin(2 * np.pi * 180 * idx) * np.exp(-((idx - idx.mean()) / 0.08) ** 2)
        swallow += swallow_env * 0.08 * np.sin(2 * np.pi * 420 * idx)
        # Artifact: large low-frequency handling noise
        art = phase["artifact"]
        artifact = art * 0.35 * np.sin(2 * np.pi * 28 * idx)
        artifact += art * 0.12 * self.rng.normal(0, 1, size=n)
        x = (noise + swallow + artifact).astype(np.float64)
        self.sample_pos += n
        return x, t_start

    def next_frame(self) -> dict:
        raw, t_start = self.next_audio_block()
        x = self.hpf(raw)
        self.history = np.concatenate([self.history, x])[-self.keep:]
        level = dsp.rms(x)
        level_db = dsp.to_dbfs(level)
        clipped = dsp.clip_fraction(raw, self.cfg.clip_level)
        dt = raw.size / self.fs
        floor_db = self.noise.update(level_db, dt)
        snr = level_db - floor_db
        spec_window = self.history[-self.cfg.nfft:]
        freqs, mag_db = dsp.spectrum_db(spec_window, self.fs, self.cfg.nfft)
        power = np.power(10.0, mag_db / 10.0)
        column = dsp.pool_spectrum(freqs, mag_db, self.cfg.spec_fmax_hz, self.cfg.spec_bins)
        hum = dsp.mains_hum_ratio(self.history[-int(self.fs * self.cfg.hum_window_s):], self.fs)
        analysis = freqs >= 20.0
        dominant = float(freqs[analysis][np.argmax(mag_db[analysis])]) if analysis.any() else 0.0
        quality = dsp.assess_quality(
            level_db, clipped, hum,
            silence_dbfs=self.cfg.silence_dbfs,
            clip_fraction_limit=self.cfg.clip_fraction,
            hum_ratio_limit=self.cfg.hum_ratio,
        )
        mins, maxs = dsp.envelope(x, self.cfg.wave_points)
        now = time.time() * 1000
        t0 = now - dt * 1000
        self.seq += 1

        def _r(v: float, nd: int = 2) -> float:
            return round(float(v), nd)

        return {
            "type": "audio_frame",
            "seq": self.seq,
            "source": "demo",
            "fs": self.fs,
            "sample_index": int(t_start * self.fs),
            "n_samples": int(raw.size),
            "t_start_unix_ms": _r(t0, 3),
            "t_end_unix_ms": _r(now, 3),
            "dropped_samples": 0,
            "waveform": {"min": [_r(v, 4) for v in mins], "max": [_r(v, 4) for v in maxs]},
            "spectrum": {"fmax_hz": min(self.cfg.spec_fmax_hz, self.fs / 2), "db": [_r(v, 1) for v in column]},
            "features": {
                "rms_dbfs": _r(level_db, 1),
                "peak": _r(dsp.peak(raw), 4),
                "clip_fraction": _r(clipped, 5),
                "zcr": _r(dsp.zero_crossing_rate(x), 4),
                "spectral_centroid_hz": _r(dsp.spectral_centroid(freqs[analysis], power[analysis]), 1),
                "dominant_hz": _r(dominant, 1),
                "band_fraction": {k: _r(v, 3) for k, v in dsp.band_fractions(freqs, power).items()},
                "hum_ratio": _r(hum, 3),
                "noise_floor_dbfs": _r(floor_db, 1),
                "snr_db": _r(snr, 1),
                "activity": bool(snr >= self.cfg.activity_db and level_db >= self.cfg.silence_dbfs),
            },
            "quality": quality.to_dict(),
            "demo": True,
        }

    def next_imu(self) -> ImuSample:
        t = time.time() - self.t0
        phase = self._phase(t)
        # Resting ~1 g on Z with small noise; artifacts spike all axes
        base_noise = 0.008
        ax = self.rng.normal(0, base_noise)
        ay = self.rng.normal(0, base_noise)
        az = 1.0 + self.rng.normal(0, base_noise)
        gx = self.rng.normal(0, 0.8)
        gy = self.rng.normal(0, 0.8)
        gz = self.rng.normal(0, 0.8)
        # Swallow: subtle biomechanical nudge
        s = phase["swallow"]
        az += s * 0.06
        gy += s * 8.0
        # Artifact: large movement
        a = phase["artifact"]
        ax += a * 0.55
        ay += a * 0.35
        az += a * 0.25
        gx += a * 120
        gy += a * 90
        gz += a * 70
        self.imu_seq += 1
        accel_mag = (ax * ax + ay * ay + az * az) ** 0.5
        gyro_mag = (gx * gx + gy * gy + gz * gz) ** 0.5
        return ImuSample(
            seq=self.imu_seq,
            board_t_ms=t * 1000,
            host_unix_ms=time.time() * 1000,
            ax=ax, ay=ay, az=az, gx=gx, gy=gy, gz=gz,
            accel_mag=accel_mag, gyro_mag=gyro_mag,
        )

    def imu_features_window(self, n: int = 5) -> dict | None:
        samples = [self.next_imu() for _ in range(n)]
        # Only return features for the last sample's window; caller typically wants one sample + features
        feats = compute_imu_features(samples)
        return {
            "sample": samples[-1].to_dict(),
            "features": feats.to_dict() if feats else None,
            "demo": True,
        }
