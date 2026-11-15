from dysphagrip_audio.imu import parse_imu_line, compute_imu_features, ImuSample


def test_parse_imu_line():
    s = parse_imu_line(
        '{"type":"imu","seq":3,"t_ms":100,"ax":0.1,"ay":0.2,"az":0.9,"gx":1,"gy":2,"gz":3}',
        host_unix_ms=5000.0,
    )
    assert s is not None
    assert s.seq == 3
    assert s.board_t_ms == 100
    assert s.host_unix_ms == 5000.0
    assert abs(s.accel_mag - (0.1**2 + 0.2**2 + 0.9**2) ** 0.5) < 1e-9


def test_parse_rejects_non_imu():
    assert parse_imu_line('{"type":"info","message":"hi"}') is None
    assert parse_imu_line("not json") is None
    assert parse_imu_line("") is None


def test_compute_imu_features_detects_motion():
    resting = [
        ImuSample(i, None, 0, 0, 0, 1.0, 0, 0, 0, 1.0, 0.0) for i in range(5)
    ]
    moving = [
        ImuSample(i, None, 0, 0.4, 0.3, 1.2, 50, 40, 30,
                  (0.4**2 + 0.3**2 + 1.2**2) ** 0.5, (50**2 + 40**2 + 30**2) ** 0.5)
        for i in range(5)
    ]
    fr = compute_imu_features(resting, motion_threshold=0.15)
    fm = compute_imu_features(moving, motion_threshold=0.15)
    assert fr is not None and not fr.above_baseline
    assert fm is not None and fm.above_baseline
    assert fm.motion_energy > fr.motion_energy
