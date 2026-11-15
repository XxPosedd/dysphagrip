"""Explainable heuristic fusion of acoustic + IMU features into candidate events.

This is NOT a clinically validated classifier. Labels are experimental heuristics for
demo and research prototyping only.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

ALGORITHM_VERSION = "heuristic-fusion-v1"


@dataclass
class FusionThresholds:
    acoustic_activity_db: float = 10.0      # SNR above floor (already in audio features)
    acoustic_rms_min_dbfs: float = -55.0
    motion_energy_artifact: float = 0.35    # high motion → likely artifact
    motion_energy_swallow_max: float = 0.28 # swallow candidates need limited motion
    motion_energy_min: float = 0.02         # some biomechanical cue preferred
    cooldown_ms: float = 800.0
    min_event_gap_ms: float = 400.0
    heuristic_score_floor: float = 0.35


@dataclass
class CandidateEvent:
    id: str
    category: str  # swallow_candidate | motion_artifact | unclassified_activity | baseline_idle
    t_unix_ms: float
    session_t_ms: float
    duration_ms: float
    heuristic_score: float
    reason: str
    features: dict[str, Any]
    algorithm_version: str = ALGORITHM_VERSION

    def to_dict(self) -> dict:
        return {
            "type": "candidate_event",
            "id": self.id,
            "category": self.category,
            "t_unix_ms": round(self.t_unix_ms, 3),
            "session_t_ms": round(self.session_t_ms, 1),
            "duration_ms": round(self.duration_ms, 1),
            "heuristic_score": round(self.heuristic_score, 3),
            "reason": self.reason,
            "features": self.features,
            "algorithm_version": self.algorithm_version,
            "disclaimer": "Experimental heuristic indicator, not a clinical diagnosis.",
        }


@dataclass
class EventDetector:
    thresholds: FusionThresholds = field(default_factory=FusionThresholds)
    _last_event_ms: float | None = None
    _counter: int = 0
    _active_since: float | None = None
    _peak_rms: float = -120.0
    _peak_snr: float = 0.0
    _peak_motion: float = 0.0
    _saw_imu: bool = False

    def reset(self) -> None:
        self._last_event_ms = None
        self._counter = 0
        self._active_since = None
        self._peak_rms = -120.0
        self._peak_snr = 0.0
        self._peak_motion = 0.0
        self._saw_imu = False

    def update(
        self,
        *,
        t_unix_ms: float,
        session_t_ms: float,
        acoustic_activity: bool,
        rms_dbfs: float,
        snr_db: float,
        motion_energy: float | None,
        imu_connected: bool,
    ) -> CandidateEvent | None:
        th = self.thresholds
        motion = motion_energy if motion_energy is not None else 0.0

        # Track contiguous acoustic activity for duration estimate
        if acoustic_activity and rms_dbfs >= th.acoustic_rms_min_dbfs:
            if self._active_since is None:
                self._active_since = t_unix_ms
                self._peak_rms = rms_dbfs
                self._peak_snr = snr_db
                self._peak_motion = motion
                self._saw_imu = imu_connected
            else:
                self._peak_rms = max(self._peak_rms, rms_dbfs)
                self._peak_snr = max(self._peak_snr, snr_db)
                self._peak_motion = max(self._peak_motion, motion)
                self._saw_imu = self._saw_imu or imu_connected
            return None

        # closing an activity burst — classify using peak features during the burst
        if self._active_since is not None:
            duration = t_unix_ms - self._active_since
            peak_rms = self._peak_rms
            peak_snr = self._peak_snr
            peak_motion = self._peak_motion
            saw_imu = self._saw_imu
            self._active_since = None
            self._peak_rms = -120.0
            self._peak_snr = 0.0
            self._peak_motion = 0.0
            self._saw_imu = False
            return self._classify_burst(
                t_unix_ms=t_unix_ms,
                session_t_ms=session_t_ms,
                duration_ms=max(duration, 50.0),
                rms_dbfs=peak_rms,
                snr_db=peak_snr,
                motion_energy=peak_motion,
                imu_connected=saw_imu,
            )
        return None

    def _classify_burst(
        self,
        *,
        t_unix_ms: float,
        session_t_ms: float,
        duration_ms: float,
        rms_dbfs: float,
        snr_db: float,
        motion_energy: float,
        imu_connected: bool,
    ) -> CandidateEvent | None:
        th = self.thresholds
        if self._last_event_ms is not None and (t_unix_ms - self._last_event_ms) < th.cooldown_ms:
            return None

        features = {
            "rms_dbfs": round(rms_dbfs, 2),
            "snr_db": round(snr_db, 2),
            "motion_energy": round(motion_energy, 5),
            "duration_ms": round(duration_ms, 1),
            "imu_connected": imu_connected,
        }

        # High motion dominates → motion artifact
        if imu_connected and motion_energy >= th.motion_energy_artifact:
            category = "motion_artifact"
            score = min(0.95, 0.5 + motion_energy)
            reason = (
                f"Acoustic burst with high IMU motion energy ({motion_energy:.3f} ≥ "
                f"{th.motion_energy_artifact}): treated as movement artifact (heuristic)."
            )
        elif not imu_connected:
            # Without IMU we cannot reject motion artifacts honestly
            category = "unclassified_activity"
            score = min(0.7, 0.35 + max(0.0, snr_db) / 40.0)
            reason = (
                "Acoustic activity above baseline without IMU confirmation — "
                "unclassified experimental indicator (IMU disconnected)."
            )
        elif motion_energy <= th.motion_energy_swallow_max and snr_db >= th.acoustic_activity_db * 0.6:
            category = "swallow_candidate"
            # Prefer moderate acoustic energy with limited motion
            score = min(
                0.9,
                0.4
                + min(0.3, max(0.0, snr_db) / 50.0)
                + min(0.2, max(0.0, th.motion_energy_swallow_max - motion_energy) * 2),
            )
            reason = (
                f"Acoustic activity (SNR {snr_db:.1f} dB) with limited motion energy "
                f"({motion_energy:.3f}): experimental swallow candidate."
            )
        else:
            category = "unclassified_activity"
            score = min(0.75, 0.35 + max(0.0, snr_db) / 45.0)
            reason = (
                f"Acoustic/motion pattern did not match swallow or artifact heuristics "
                f"(motion_energy={motion_energy:.3f})."
            )

        if score < th.heuristic_score_floor and category == "unclassified_activity":
            return None

        self._counter += 1
        self._last_event_ms = t_unix_ms
        return CandidateEvent(
            id=f"evt-{self._counter}",
            category=category,
            t_unix_ms=t_unix_ms,
            session_t_ms=session_t_ms,
            duration_ms=duration_ms,
            heuristic_score=score,
            reason=reason,
            features=features,
        )


def classify_idle(motion_energy: float | None, acoustic_activity: bool) -> str:
    if acoustic_activity:
        return "active"
    if motion_energy is not None and motion_energy > 0.2:
        return "moving"
    return "baseline_idle"
