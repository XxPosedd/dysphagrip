from dysphagrip_audio.fusion import EventDetector, FusionThresholds, classify_idle


def test_motion_artifact_when_high_imu_energy():
    d = EventDetector(FusionThresholds(cooldown_ms=0))
    # Start activity
    assert d.update(
        t_unix_ms=1000, session_t_ms=0, acoustic_activity=True,
        rms_dbfs=-30, snr_db=20, motion_energy=0.5, imu_connected=True,
    ) is None
    # End activity → classify
    ev = d.update(
        t_unix_ms=1200, session_t_ms=200, acoustic_activity=False,
        rms_dbfs=-60, snr_db=2, motion_energy=0.5, imu_connected=True,
    )
    assert ev is not None
    assert ev.category == "motion_artifact"
    assert "heuristic" in ev.reason.lower() or "artifact" in ev.reason.lower()
    assert ev.algorithm_version.startswith("heuristic")


def test_swallow_candidate_with_limited_motion():
    d = EventDetector(FusionThresholds(cooldown_ms=0))
    d.update(
        t_unix_ms=1000, session_t_ms=0, acoustic_activity=True,
        rms_dbfs=-28, snr_db=18, motion_energy=0.05, imu_connected=True,
    )
    ev = d.update(
        t_unix_ms=1300, session_t_ms=300, acoustic_activity=False,
        rms_dbfs=-55, snr_db=3, motion_energy=0.05, imu_connected=True,
    )
    assert ev is not None
    assert ev.category == "swallow_candidate"
    assert 0.35 <= ev.heuristic_score <= 0.95


def test_unclassified_without_imu():
    d = EventDetector(FusionThresholds(cooldown_ms=0))
    d.update(
        t_unix_ms=1000, session_t_ms=0, acoustic_activity=True,
        rms_dbfs=-30, snr_db=15, motion_energy=None, imu_connected=False,
    )
    ev = d.update(
        t_unix_ms=1200, session_t_ms=200, acoustic_activity=False,
        rms_dbfs=-60, snr_db=1, motion_energy=None, imu_connected=False,
    )
    assert ev is not None
    assert ev.category == "unclassified_activity"


def test_cooldown_suppresses_burst():
    d = EventDetector(FusionThresholds(cooldown_ms=2000))
    d.update(t_unix_ms=1000, session_t_ms=0, acoustic_activity=True,
             rms_dbfs=-30, snr_db=18, motion_energy=0.05, imu_connected=True)
    first = d.update(t_unix_ms=1200, session_t_ms=200, acoustic_activity=False,
                     rms_dbfs=-60, snr_db=1, motion_energy=0.05, imu_connected=True)
    assert first is not None
    d.update(t_unix_ms=1300, session_t_ms=300, acoustic_activity=True,
             rms_dbfs=-30, snr_db=18, motion_energy=0.05, imu_connected=True)
    second = d.update(t_unix_ms=1500, session_t_ms=500, acoustic_activity=False,
                      rms_dbfs=-60, snr_db=1, motion_energy=0.05, imu_connected=True)
    assert second is None


def test_classify_idle():
    assert classify_idle(0.01, False) == "baseline_idle"
    assert classify_idle(0.5, False) == "moving"
    assert classify_idle(0.01, True) == "active"
