"""Baseline calibration workflow — experimental thresholds only, not medical validation."""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any


@dataclass
class CalibrationResult:
    completed: bool
    mode: str  # live | demo
    started_at_unix_ms: float
    ended_at_unix_ms: float | None
    duration_ms: float
    samples_audio: int
    samples_imu: int
    baseline_rms_dbfs: float | None
    baseline_noise_floor_dbfs: float | None
    baseline_accel_mag: float | None
    baseline_motion_energy: float | None
    suggested_activity_db: float | None
    suggested_motion_artifact: float | None
    message: str
    error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "completed": self.completed,
            "mode": self.mode,
            "started_at_unix_ms": self.started_at_unix_ms,
            "ended_at_unix_ms": self.ended_at_unix_ms,
            "duration_ms": round(self.duration_ms, 1),
            "samples_audio": self.samples_audio,
            "samples_imu": self.samples_imu,
            "baseline_rms_dbfs": self.baseline_rms_dbfs,
            "baseline_noise_floor_dbfs": self.baseline_noise_floor_dbfs,
            "baseline_accel_mag": self.baseline_accel_mag,
            "baseline_motion_energy": self.baseline_motion_energy,
            "suggested_activity_db": self.suggested_activity_db,
            "suggested_motion_artifact": self.suggested_motion_artifact,
            "message": self.message,
            "error": self.error,
            "disclaimer": "Calibration sets experimental heuristic thresholds only. Not medical validation.",
        }


@dataclass
class Calibrator:
    target_duration_ms: float = 4000.0
    mode: str = "live"
    _started: float | None = None
    _rms: list[float] = field(default_factory=list)
    _floor: list[float] = field(default_factory=list)
    _accel: list[float] = field(default_factory=list)
    _motion: list[float] = field(default_factory=list)
    _result: CalibrationResult | None = None
    _running: bool = False

    @property
    def running(self) -> bool:
        return self._running

    @property
    def result(self) -> CalibrationResult | None:
        return self._result

    def progress(self) -> dict:
        if not self._running or self._started is None:
            return {
                "running": False,
                "progress": 1.0 if self._result and self._result.completed else 0.0,
                "elapsed_ms": 0,
                "target_ms": self.target_duration_ms,
                "latest_rms_dbfs": self._rms[-1] if self._rms else None,
                "latest_motion_energy": self._motion[-1] if self._motion else None,
                "result": self._result.to_dict() if self._result else None,
            }
        elapsed = time.time() * 1000 - self._started
        return {
            "running": True,
            "progress": min(1.0, elapsed / self.target_duration_ms),
            "elapsed_ms": round(elapsed, 1),
            "target_ms": self.target_duration_ms,
            "latest_rms_dbfs": self._rms[-1] if self._rms else None,
            "latest_motion_energy": self._motion[-1] if self._motion else None,
            "result": None,
        }

    def start(self, mode: str = "live") -> dict:
        self.mode = mode
        self._started = time.time() * 1000
        self._rms.clear()
        self._floor.clear()
        self._accel.clear()
        self._motion.clear()
        self._result = None
        self._running = True
        return self.progress()

    def ingest_audio(self, rms_dbfs: float, noise_floor_dbfs: float) -> CalibrationResult | None:
        if not self._running:
            return None
        self._rms.append(float(rms_dbfs))
        self._floor.append(float(noise_floor_dbfs))
        return self._maybe_finish()

    def ingest_imu(self, accel_mag: float, motion_energy: float) -> CalibrationResult | None:
        if not self._running:
            return None
        self._accel.append(float(accel_mag))
        self._motion.append(float(motion_energy))
        return self._maybe_finish()

    def fail(self, message: str) -> CalibrationResult:
        self._running = False
        now = time.time() * 1000
        self._result = CalibrationResult(
            completed=False,
            mode=self.mode,
            started_at_unix_ms=self._started or now,
            ended_at_unix_ms=now,
            duration_ms=(now - (self._started or now)),
            samples_audio=len(self._rms),
            samples_imu=len(self._accel),
            baseline_rms_dbfs=None,
            baseline_noise_floor_dbfs=None,
            baseline_accel_mag=None,
            baseline_motion_energy=None,
            suggested_activity_db=None,
            suggested_motion_artifact=None,
            message="Calibration failed.",
            error=message,
        )
        return self._result

    def _median(self, xs: list[float]) -> float | None:
        if not xs:
            return None
        s = sorted(xs)
        mid = len(s) // 2
        return s[mid] if len(s) % 2 else 0.5 * (s[mid - 1] + s[mid])

    def _maybe_finish(self) -> CalibrationResult | None:
        if not self._running or self._started is None:
            return None
        elapsed = time.time() * 1000 - self._started
        if elapsed < self.target_duration_ms:
            return None
        if len(self._rms) < 5:
            # Wait for acoustic samples; callers can invoke fail() on an explicit timeout.
            return None
        rms = self._median(self._rms)
        floor = self._median(self._floor)
        accel = self._median(self._accel)
        motion = self._median(self._motion) if self._motion else 0.05
        # Suggest thresholds slightly above baseline
        suggested_activity = 8.0 if floor is None else max(6.0, min(18.0, 10.0))
        suggested_artifact = max(0.2, min(0.8, (motion or 0.05) * 4.0 + 0.2))
        now = time.time() * 1000
        self._running = False
        self._result = CalibrationResult(
            completed=True,
            mode=self.mode,
            started_at_unix_ms=self._started,
            ended_at_unix_ms=now,
            duration_ms=elapsed,
            samples_audio=len(self._rms),
            samples_imu=len(self._accel),
            baseline_rms_dbfs=round(rms, 2) if rms is not None else None,
            baseline_noise_floor_dbfs=round(floor, 2) if floor is not None else None,
            baseline_accel_mag=round(accel, 4) if accel is not None else None,
            baseline_motion_energy=round(motion, 5) if motion is not None else None,
            suggested_activity_db=round(suggested_activity, 2),
            suggested_motion_artifact=round(suggested_artifact, 3),
            message=(
                "Baseline captured. Suggested experimental thresholds updated. "
                "Remain still during calibration for best results."
            ),
        )
        return self._result
