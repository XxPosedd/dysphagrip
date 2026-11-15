"""Local session persistence (SQLite). Raw audio is never stored by default."""
from __future__ import annotations

import json
import sqlite3
import threading
import time
import uuid
from pathlib import Path
from typing import Any


SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  mode TEXT NOT NULL,
  started_at_unix_ms REAL NOT NULL,
  ended_at_unix_ms REAL,
  duration_ms REAL NOT NULL DEFAULT 0,
  swallow_candidates INTEGER NOT NULL DEFAULT 0,
  motion_artifacts INTEGER NOT NULL DEFAULT 0,
  unclassified INTEGER NOT NULL DEFAULT 0,
  audio_source TEXT,
  imu_transport TEXT,
  signal_quality_summary TEXT,
  calibration_json TEXT,
  events_json TEXT NOT NULL DEFAULT '[]',
  metrics_json TEXT NOT NULL DEFAULT '{}',
  created_at_unix_ms REAL NOT NULL
);
"""


class SessionStore:
    def __init__(self, path: str | Path | None = None):
        if path is None:
            path = Path(__file__).resolve().parents[1] / "data" / "sessions.sqlite"
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        with self._connect() as conn:
            conn.executescript(SCHEMA)

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        return conn

    def create_live(self, *, label: str, mode: str, audio_source: str | None,
                    imu_transport: str | None, calibration: dict | None) -> dict:
        sid = str(uuid.uuid4())
        now = time.time() * 1000
        row = {
            "id": sid,
            "label": label,
            "mode": mode,
            "started_at_unix_ms": now,
            "ended_at_unix_ms": None,
            "duration_ms": 0,
            "swallow_candidates": 0,
            "motion_artifacts": 0,
            "unclassified": 0,
            "audio_source": audio_source,
            "imu_transport": imu_transport,
            "signal_quality_summary": None,
            "calibration_json": json.dumps(calibration) if calibration else None,
            "events_json": "[]",
            "metrics_json": "{}",
            "created_at_unix_ms": now,
        }
        with self._lock, self._connect() as conn:
            conn.execute(
                """INSERT INTO sessions (
                    id, label, mode, started_at_unix_ms, ended_at_unix_ms, duration_ms,
                    swallow_candidates, motion_artifacts, unclassified, audio_source,
                    imu_transport, signal_quality_summary, calibration_json, events_json,
                    metrics_json, created_at_unix_ms
                ) VALUES (
                    :id, :label, :mode, :started_at_unix_ms, :ended_at_unix_ms, :duration_ms,
                    :swallow_candidates, :motion_artifacts, :unclassified, :audio_source,
                    :imu_transport, :signal_quality_summary, :calibration_json, :events_json,
                    :metrics_json, :created_at_unix_ms
                )""",
                row,
            )
        return self.get(sid)  # type: ignore[return-value]

    def finalize(self, session_id: str, *, events: list[dict], metrics: dict,
                 quality_summary: str | None = None) -> dict | None:
        now = time.time() * 1000
        with self._lock, self._connect() as conn:
            row = conn.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
            if not row:
                return None
            started = float(row["started_at_unix_ms"])
            counts = {"swallow_candidate": 0, "motion_artifact": 0, "unclassified_activity": 0}
            for e in events:
                cat = e.get("category")
                if cat in counts:
                    counts[cat] += 1
            conn.execute(
                """UPDATE sessions SET
                    ended_at_unix_ms = ?, duration_ms = ?, swallow_candidates = ?,
                    motion_artifacts = ?, unclassified = ?, signal_quality_summary = ?,
                    events_json = ?, metrics_json = ?
                   WHERE id = ?""",
                (
                    now,
                    max(0.0, now - started),
                    counts["swallow_candidate"],
                    counts["motion_artifact"],
                    counts["unclassified_activity"],
                    quality_summary,
                    json.dumps(events),
                    json.dumps(metrics),
                    session_id,
                ),
            )
        return self.get(session_id)

    def list(self, limit: int = 50) -> list[dict]:
        with self._lock, self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM sessions ORDER BY created_at_unix_ms DESC LIMIT ?",
                (limit,),
            ).fetchall()
        return [self._row_to_summary(r) for r in rows]

    def get(self, session_id: str) -> dict | None:
        with self._lock, self._connect() as conn:
            row = conn.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
        if not row:
            return None
        return self._row_to_detail(row)

    def delete(self, session_id: str) -> bool:
        with self._lock, self._connect() as conn:
            cur = conn.execute("DELETE FROM sessions WHERE id = ?", (session_id,))
            return cur.rowcount > 0

    def export(self, session_id: str, fmt: str = "json") -> tuple[str, str] | None:
        detail = self.get(session_id)
        if not detail:
            return None
        if fmt == "csv":
            lines = ["category,session_t_ms,duration_ms,heuristic_score,reason"]
            for e in detail.get("events", []):
                reason = (e.get("reason") or "").replace('"', "'")
                lines.append(
                    f"{e.get('category')},{e.get('session_t_ms')},{e.get('duration_ms')},"
                    f"{e.get('heuristic_score')},\"{reason}\""
                )
            return "\n".join(lines) + "\n", "text/csv"
        return json.dumps(detail, indent=2), "application/json"

    def _row_to_summary(self, row: sqlite3.Row) -> dict:
        return {
            "id": row["id"],
            "label": row["label"],
            "mode": row["mode"],
            "started_at_unix_ms": row["started_at_unix_ms"],
            "ended_at_unix_ms": row["ended_at_unix_ms"],
            "duration_ms": row["duration_ms"],
            "swallow_candidates": row["swallow_candidates"],
            "motion_artifacts": row["motion_artifacts"],
            "unclassified": row["unclassified"],
            "audio_source": row["audio_source"],
            "imu_transport": row["imu_transport"],
            "signal_quality_summary": row["signal_quality_summary"],
            "created_at_unix_ms": row["created_at_unix_ms"],
        }

    def _row_to_detail(self, row: sqlite3.Row) -> dict:
        summary = self._row_to_summary(row)
        summary["events"] = json.loads(row["events_json"] or "[]")
        summary["metrics"] = json.loads(row["metrics_json"] or "{}")
        summary["calibration"] = json.loads(row["calibration_json"]) if row["calibration_json"] else None
        return summary
