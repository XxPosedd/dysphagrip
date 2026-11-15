import { useCallback, useEffect, useState } from "react";
import { monitorApi } from "../lib/monitorApi";
import type { MonitorSessionSummary } from "../lib/monitorTypes";
import { formatDuration } from "../lib/format";

export function SessionsPage() {
  const [sessions, setSessions] = useState<MonitorSessionSummary[]>([]);
  const [selected, setSelected] = useState<MonitorSessionSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await monitorApi.sessions();
      setSessions(r.sessions);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const open = async (id: string) => {
    try {
      setSelected(await monitorApi.session(id));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Sessions</h1>
          <p className="lede">Local session archive (SQLite). Raw audio is never stored by default.</p>
        </div>
        <button className="btn btn-ghost" onClick={() => void load()}>Refresh</button>
      </header>
      {error && <div className="banner-error">{error}</div>}

      <div className="sessions-layout">
        <section className="card-flat">
          <table className="data-table">
            <thead>
              <tr>
                <th>Label</th>
                <th>Mode</th>
                <th>Duration</th>
                <th>Candidates</th>
                <th>Artifacts</th>
                <th>Quality</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.id}>
                  <td>{s.label}</td>
                  <td>{s.mode}</td>
                  <td className="tabular">{formatDuration(s.duration_ms)}</td>
                  <td className="tabular">{s.swallow_candidates}</td>
                  <td className="tabular">{s.motion_artifacts}</td>
                  <td>{s.signal_quality_summary ?? "—"}</td>
                  <td className="row-actions">
                    <button className="btn btn-sm" onClick={() => void open(s.id)}>Inspect</button>
                    <a className="btn btn-sm" href={monitorApi.exportUrl(s.id, "json")}>JSON</a>
                    <a className="btn btn-sm" href={monitorApi.exportUrl(s.id, "csv")}>CSV</a>
                    <button className="btn btn-sm" onClick={() => void monitorApi.deleteSession(s.id).then(load)}>Delete</button>
                  </td>
                </tr>
              ))}
              {!sessions.length && (
                <tr><td colSpan={7} className="muted">No saved sessions yet. Stop a monitoring run to archive one.</td></tr>
              )}
            </tbody>
          </table>
        </section>

        {selected && (
          <section className="card-flat">
            <header className="card-head">
              <h2>{selected.label}</h2>
              <button className="btn btn-sm" onClick={() => setSelected(null)}>Close</button>
            </header>
            <p className="muted small">
              {selected.mode} · {selected.audio_source || "audio n/a"} · IMU {selected.imu_transport || "n/a"}
            </p>
            <ol className="event-list">
              {(selected.events || []).map((e) => (
                <li key={e.id}>
                  <span className={`badge cat-${e.category}`}>{e.category}</span>
                  <span className="tabular muted">{formatDuration(e.session_t_ms)}</span>
                  <span className="grow">{e.reason}</span>
                </li>
              ))}
              {!selected.events?.length && <li className="muted">No events in this session.</li>}
            </ol>
          </section>
        )}
      </div>
    </div>
  );
}
