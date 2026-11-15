"""Turns raw samples from a source into streamable frames (waveform, spectrogram column, features)."""
from __future__ import annotations

import numpy as np

from . import dsp
from .config import AudioConfig


def _r(x: float, nd: int = 2) -> float:
    return round(float(x), nd)


class FrameProcessor:
    def __init__(self, source, config: AudioConfig | None = None):
        self.source = source
        self.cfg = config or AudioConfig()
        fs = source.fs
        self.hpf = dsp.StreamingFilter(dsp.design_highpass(fs, min(self.cfg.highpass_hz, fs / 4)))
        self.keep = max(self.cfg.nfft, int(fs * self.cfg.hum_window_s))
        self.history = np.zeros(0, dtype=np.float64)
        self.noise = dsp.NoiseFloorTracker()
        self.pos = 0
        self.seq = 0
        self.dropped_total = 0

    def process(self) -> dict | None:
        """Consume all new samples and return one frame, or None if nothing new arrived."""
        raw, start, dropped = self.source.buffer.read_since(self.pos)
        self.dropped_total += dropped
        if raw.size == 0:
            return None
        self.pos = start + raw.size
        cfg, fs = self.cfg, self.source.fs

        x = self.hpf(raw.astype(np.float64))
        self.history = np.concatenate([self.history, x])[-self.keep:]

        level = dsp.rms(x)
        level_db = dsp.to_dbfs(level)
        clipped = dsp.clip_fraction(raw, cfg.clip_level)       # clipping is judged pre-filter
        dt = raw.size / fs
        floor_db = self.noise.update(level_db, dt)
        snr = level_db - floor_db

        spec_window = self.history[-cfg.nfft:]
        freqs, mag_db = dsp.spectrum_db(spec_window, fs, cfg.nfft)
        power = np.power(10.0, mag_db / 10.0)
        column = dsp.pool_spectrum(freqs, mag_db, cfg.spec_fmax_hz, cfg.spec_bins)
        hum = dsp.mains_hum_ratio(self.history[-int(fs * cfg.hum_window_s):], fs)
        analysis = freqs >= 20.0
        dominant = float(freqs[analysis][np.argmax(mag_db[analysis])]) if analysis.any() else 0.0

        quality = dsp.assess_quality(level_db, clipped, hum, silence_dbfs=cfg.silence_dbfs,
                                     clip_fraction_limit=cfg.clip_fraction, hum_ratio_limit=cfg.hum_ratio)
        mins, maxs = dsp.envelope(x, cfg.wave_points)
        t0 = self.source.sample_time_unix_ms(start)
        t1 = self.source.sample_time_unix_ms(self.pos)

        self.seq += 1
        return {
            "type": "audio_frame",
            "seq": self.seq,
            "source": self.source.kind,
            "fs": fs,
            "sample_index": start,
            "n_samples": int(raw.size),
            "t_start_unix_ms": None if t0 is None else _r(t0, 3),
            "t_end_unix_ms": None if t1 is None else _r(t1, 3),
            "dropped_samples": int(dropped),
            "waveform": {"min": [_r(v, 4) for v in mins], "max": [_r(v, 4) for v in maxs]},
            "spectrum": {"fmax_hz": min(cfg.spec_fmax_hz, fs / 2), "db": [_r(v, 1) for v in column]},
            "features": {
                "rms_dbfs": _r(level_db, 1),
                "raw_rms": dsp.rms(raw),  # Unfiltered linear RMS for Proyecto 2 fusion.
                "peak": _r(dsp.peak(raw), 4),
                "clip_fraction": _r(clipped, 5),
                "zcr": _r(dsp.zero_crossing_rate(x), 4),
                "spectral_centroid_hz": _r(dsp.spectral_centroid(freqs[analysis], power[analysis]), 1),
                "dominant_hz": _r(dominant, 1),
                "band_fraction": {k: _r(v, 3) for k, v in dsp.band_fractions(freqs, power).items()},
                "hum_ratio": _r(hum, 3),
                "noise_floor_dbfs": _r(floor_db, 1),
                "snr_db": _r(snr, 1),
                "activity": bool(snr >= cfg.activity_db and level_db >= cfg.silence_dbfs),
            },
            "quality": quality.to_dict(),
        }
