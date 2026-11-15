from __future__ import annotations

from dataclasses import dataclass, asdict


@dataclass(frozen=True)
class AudioConfig:
    """Processing parameters. Defaults are engineering starting points, not validated thresholds."""

    hop_ms: float = 50.0             # one frame streamed to clients every ~50 ms (20 fps)
    nfft: int = 2048                 # FFT size for the spectrogram column
    spec_fmax_hz: float = 4000.0     # upper frequency shown in the spectrogram
    spec_bins: int = 128             # spectrogram column height sent to clients
    wave_points: int = 200           # min/max envelope points per frame
    highpass_hz: float = 20.0        # removes DC offset / sub-audio rumble
    hum_window_s: float = 0.5        # analysis window for 50/60 Hz mains hum
    buffer_seconds: float = 10.0     # ring buffer length

    silence_dbfs: float = -70.0      # below this RMS -> "no_signal"
    clip_level: float = 0.98         # |x| >= this counts as clipped (raw, pre-filter)
    clip_fraction: float = 0.001     # fraction of clipped samples that flags clipping
    hum_ratio: float = 0.5           # fraction of 20-1000 Hz power at mains lines -> "mains_hum"
    activity_db: float = 10.0        # dB above tracked noise floor -> audio activity

    def to_dict(self) -> dict:
        return asdict(self)
