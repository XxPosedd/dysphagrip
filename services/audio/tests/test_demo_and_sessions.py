import json
from pathlib import Path

from fastapi.testclient import TestClient

from dysphagrip_audio.calibration import Calibrator
from dysphagrip_audio.config import AudioConfig
from dysphagrip_audio.demo import DemoGenerator
from dysphagrip_audio.server import create_app
from dysphagrip_audio.sessions_store import SessionStore


def test_demo_frames_are_labelled():
    g = DemoGenerator(AudioConfig(), seed=1)
    frame = g.next_frame()
    assert frame["source"] == "demo"
    assert frame["demo"] is True
    assert "waveform" in frame and len(frame["waveform"]["min"]) > 0
    imu = g.next_imu()
    assert imu.accel_mag > 0.5


def test_demo_is_deterministic_with_seed():
    a = DemoGenerator(AudioConfig(), seed=7)
    b = DemoGenerator(AudioConfig(), seed=7)
    fa, fb = a.next_frame(), b.next_frame()
    assert fa["features"]["rms_dbfs"] == fb["features"]["rms_dbfs"]


def test_calibration_completes_with_samples():
    c = Calibrator(target_duration_ms=10)
    c.start(mode="demo")
    assert c._started is not None
    c._started -= 50  # window already elapsed
    for _ in range(5):
        c.ingest_imu(1.0, 0.04)
    for _ in range(4):
        assert c.ingest_audio(-50.0, -55.0) is None
    result = c.ingest_audio(-50.0, -55.0)
    assert result is not None
    assert result.completed
    assert result.baseline_rms_dbfs is not None
    assert "experimental" in result.to_dict()["disclaimer"].lower()


def test_calibration_fails_without_audio():
    c = Calibrator(target_duration_ms=1)
    c.start(mode="live")
    import time
    time.sleep(0.005)
    result = c.fail("Not enough acoustic samples during calibration. Is the audio stream running?")
    assert result is not None
    assert result.completed is False
    assert result.error


def test_session_store_roundtrip(tmp_path: Path):
    store = SessionStore(tmp_path / "s.sqlite")
    row = store.create_live(label="t", mode="demo", audio_source="demo", imu_transport="demo", calibration=None)
    events = [{"category": "swallow_candidate", "session_t_ms": 100, "duration_ms": 200,
               "heuristic_score": 0.6, "reason": "test"}]
    saved = store.finalize(row["id"], events=events, metrics={"frames": 3}, quality_summary="ok")
    assert saved["swallow_candidates"] == 1
    listed = store.list()
    assert len(listed) == 1
    detail = store.get(row["id"])
    assert detail["events"][0]["category"] == "swallow_candidate"
    body, media = store.export(row["id"], "json")
    assert media == "application/json"
    assert json.loads(body)["id"] == row["id"]
    csv_body, csv_media = store.export(row["id"], "csv")
    assert csv_media == "text/csv"
    assert "swallow_candidate" in csv_body


def test_api_mode_and_demo_session():
    app = create_app(allowed_origins=["http://test"])
    client = TestClient(app)
    r = client.get("/api/health")
    assert r.status_code == 200
    assert r.json()["ok"] is True

    r = client.post("/api/mode", json={"mode": "demo"})
    assert r.status_code == 200
    assert r.json()["mode"] == "demo"

    r = client.post("/api/sessions/start", json={"label": "demo-test"})
    assert r.status_code == 200
    sid = r.json()["session_id"]
    assert sid

    r = client.post("/api/sessions/stop")
    assert r.status_code == 200
    assert r.json()["saved"] is not None

    r = client.get("/api/sessions")
    assert r.status_code == 200
    assert any(s["id"] == sid for s in r.json()["sessions"])

    r = client.get(f"/api/sessions/{sid}/export?format=json")
    assert r.status_code == 200
