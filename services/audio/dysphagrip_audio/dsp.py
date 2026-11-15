"""Pure signal-processing functions. No hardware access; fully unit-tested.

All amplitude values assume float samples in [-1, 1] (full scale = 1.0).
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from scipy import signal as sps

EPS = 1e-12


def rms(x: np.ndarray) -> float:
    if x.size == 0:
        return 0.0
    return float(np.sqrt(np.mean(np.square(x, dtype=np.float64))))


def to_dbfs(value: float) -> float:
    return float(20.0 * np.log10(max(value, EPS)))


def peak(x: np.ndarray) -> float:
    return float(np.max(np.abs(x))) if x.size else 0.0


def clip_fraction(x: np.ndarray, level: float = 0.98) -> float:
    if x.size == 0:
        return 0.0
    return float(np.count_nonzero(np.abs(x) >= level) / x.size)


def zero_crossing_rate(x: np.ndarray) -> float:
    """Fraction of adjacent sample pairs that change sign."""
    if x.size < 2:
        return 0.0
    signs = np.signbit(x)
    return float(np.count_nonzero(signs[1:] != signs[:-1]) / (x.size - 1))


def spectrum_db(x: np.ndarray, fs: float, nfft: int | None = None) -> tuple[np.ndarray, np.ndarray]:
    """Hann-windowed magnitude spectrum in dBFS.

    Amplitude-normalised so a full-scale sine reads ~0 dBFS at its frequency.
    Returns (freqs_hz, magnitude_db).
    """
    n = x.size
    nfft = max(nfft or n, n)
    if n == 0:
        freqs = np.fft.rfftfreq(nfft, 1.0 / fs)
        return freqs, np.full(freqs.shape, to_dbfs(0.0))
    window = sps.get_window("hann", n, fftbins=True)
    spec = np.fft.rfft(x * window, nfft)
    mag = np.abs(spec) * 2.0 / np.sum(window)
    freqs = np.fft.rfftfreq(nfft, 1.0 / fs)
    return freqs, 20.0 * np.log10(np.maximum(mag, EPS))


def pool_spectrum(freqs: np.ndarray, mag_db: np.ndarray, fmax: float, n_bins: int) -> np.ndarray:
    """Reduce a spectrum to n_bins equal-width bands over [0, fmax].

    Each output band takes the max of the FFT bins whose frequency falls inside it;
    bands containing no FFT bin (coarse FFT) are filled by interpolation.
    """
    fmax = min(fmax, float(freqs[-1]))
    mask = freqs <= fmax
    f, m = freqs[mask], mag_db[mask]
    idx = np.minimum((f / fmax * n_bins).astype(int), n_bins - 1)
    out = np.full(n_bins, -np.inf)
    np.maximum.at(out, idx, m)
    empty = ~np.isfinite(out)
    if empty.any():
        centres = (np.arange(n_bins) + 0.5) * fmax / n_bins
        out[empty] = np.interp(centres[empty], f, m)
    return out


def spectral_centroid(freqs: np.ndarray, power: np.ndarray) -> float:
    total = float(np.sum(power))
    if total <= EPS:
        return 0.0
    return float(np.sum(freqs * power) / total)


def band_fractions(freqs: np.ndarray, power: np.ndarray,
                   bands: dict[str, tuple[float, float]] | None = None) -> dict[str, float]:
    """Fraction of total power (20 Hz .. top band edge) falling in each band."""
    bands = bands or {"low": (20.0, 250.0), "mid": (250.0, 1000.0), "high": (1000.0, 4000.0)}
    lo = min(b[0] for b in bands.values())
    hi = max(b[1] for b in bands.values())
    total = float(np.sum(power[(freqs >= lo) & (freqs < hi)]))
    if total <= EPS:
        return {k: 0.0 for k in bands}
    return {k: float(np.sum(power[(freqs >= a) & (freqs < b)]) / total) for k, (a, b) in bands.items()}


def mains_hum_ratio(x: np.ndarray, fs: float, mains: tuple[float, ...] = (50.0, 60.0),
                    harmonics: int = 3, tolerance_hz: float = 3.0) -> float:
    """Fraction of 20-1000 Hz power concentrated at mains frequencies and harmonics.

    Contact pickups on high-impedance inputs are prone to 50/60 Hz hum from poor
    grounding. Uses Welch's method with ~1 Hz resolution when the buffer allows.
    """
    if x.size < int(fs * 0.1):
        return 0.0
    nperseg = min(x.size, int(fs))
    freqs, psd = sps.welch(x, fs=fs, window="hann", nperseg=nperseg)
    band = (freqs >= 20.0) & (freqs <= 1000.0)
    total = float(np.sum(psd[band]))
    if total <= EPS:
        return 0.0
    hum_mask = np.zeros_like(freqs, dtype=bool)
    for base in mains:
        for h in range(1, harmonics + 1):
            hum_mask |= np.abs(freqs - base * h) <= tolerance_hz
    return float(np.sum(psd[band & hum_mask]) / total)


def envelope(x: np.ndarray, n_points: int) -> tuple[np.ndarray, np.ndarray]:
    """Min/max envelope for waveform drawing. Returns (mins, maxs), each <= n_points long."""
    if x.size == 0:
        return np.zeros(0), np.zeros(0)
    n_points = min(n_points, x.size)
    chunks = np.array_split(x, n_points)
    return np.array([c.min() for c in chunks]), np.array([c.max() for c in chunks])


def design_highpass(fs: float, cutoff_hz: float, order: int = 2) -> np.ndarray:
    return sps.butter(order, cutoff_hz, btype="highpass", fs=fs, output="sos")


class StreamingFilter:
    """Stateful SOS filter so consecutive blocks are filtered without edge transients."""

    def __init__(self, sos: np.ndarray):
        self.sos = sos
        self.zi: np.ndarray | None = None

    def __call__(self, x: np.ndarray) -> np.ndarray:
        if x.size == 0:
            return x
        if self.zi is None:
            self.zi = sps.sosfilt_zi(self.sos) * x[0]
        y, self.zi = sps.sosfilt(self.sos, x, zi=self.zi)
        return y


class NoiseFloorTracker:
    """Adaptive noise floor in dBFS: falls quickly toward quieter frames, rises slowly.

    "Activity" means energy meaningfully above this floor. It is a generic audio
    activity flag, NOT a swallow detector.
    """

    def __init__(self, fall_tau_s: float = 0.3, rise_db_per_s: float = 1.5):
        self.fall_tau_s = fall_tau_s
        self.rise_db_per_s = rise_db_per_s
        self.floor_db: float | None = None

    def update(self, level_db: float, dt_s: float) -> float:
        if self.floor_db is None:
            self.floor_db = level_db
        elif level_db < self.floor_db:
            alpha = min(1.0, dt_s / self.fall_tau_s)
            self.floor_db += (level_db - self.floor_db) * alpha
        else:
            self.floor_db += min(level_db - self.floor_db, self.rise_db_per_s * dt_s)
        return self.floor_db


@dataclass
class QualityAssessment:
    label: str                     # "ok" | "no_signal" | "clipping" | "mains_hum"
    reasons: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {"label": self.label, "reasons": self.reasons}


def assess_quality(rms_dbfs: float, clipped: float, hum: float, *, silence_dbfs: float,
                   clip_fraction_limit: float, hum_ratio_limit: float) -> QualityAssessment:
    """Rule-based recording-quality check. Priority: no_signal > clipping > mains_hum > ok."""
    flags: list[tuple[str, str]] = []
    if rms_dbfs < silence_dbfs:
        flags.append(("no_signal", f"Level {rms_dbfs:.0f} dBFS is below {silence_dbfs:.0f} dBFS: "
                                   "check cable, input selection and gain."))
    if clipped > clip_fraction_limit:
        flags.append(("clipping", f"{clipped * 100:.2f}% of samples are clipping: reduce input gain."))
    if hum > hum_ratio_limit:
        flags.append(("mains_hum", f"{hum * 100:.0f}% of low-band power is 50/60 Hz hum: "
                                   "check grounding and cable."))
    if not flags:
        return QualityAssessment("ok")
    return QualityAssessment(flags[0][0], [r for _, r in flags])
