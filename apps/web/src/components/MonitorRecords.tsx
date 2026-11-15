import { useEffect, useState } from "react";
import { formatDuration } from "../lib/format";
import { monitor, type MonitorHistory, type Research } from "../lib/monitor";
import { ConditionAbout } from "./ConditionAbout";
import { Card } from "./Panels";

export function MonitorHistoryPanel({ revision }: { revision: number }) {
  const [data, setData] = useState<MonitorHistory | null>(null);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let current = true;
    monitor.history().then(result => {
      if (current) { setData(result); setError(""); }
    }).catch(() => { if (current) setError("Session history is unavailable."); });
    return () => { current = false; };
  }, [revision, reload]);

  return <div id="history"><Card title="Session history" aside={
    <button className="btn btn-ghost btn-sm" onClick={() => setReload(value => value + 1)}>Refresh</button>}>
    {error && <p className="error" role="alert">{error}</p>}
    {data && <p className="small muted">{data.storage === "neon" ? "Neon connected" : "Reading local history"}</p>}
    {data?.sessions.length ? <div className="monitor-table-wrap"><table className="monitor-table">
      <thead><tr><th scope="col">Recorded</th><th scope="col">Summary source</th><th scope="col">Duration</th><th scope="col">Manual marks</th><th scope="col">Candidate events</th></tr></thead>
      <tbody>{data.sessions.map(item => <tr key={item.session_id}>
        <th scope="row"><time dateTime={item.started_at}>{new Date(item.started_at).toLocaleString("en-US", {
          month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit",
        })}</time></th>
        <td>{item.source === "neon" ? "Neon" : item.source === "local" ? "Local" : "Unknown"}</td>
        <td>{formatDuration(item.duration_seconds * 1000)}</td><td>{item.marks}</td><td>{item.event_count}</td>
      </tr>)}</tbody></table></div> :
      !error && <p className="monitor-note">{data ? "No recordings yet." : "Loading sessions…"}</p>}
  </Card></div>;
}

export function ResearchPanel() {
  const [data, setData] = useState<Research | null>(null);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let current = true;
    monitor.research().then(result => {
      if (current) { setData(result); setError(""); }
    }).catch(() => { if (current) setError("Research sources are unavailable."); });
    return () => { current = false; };
  }, [reload]);

  const source = { bright_data_live: "Retrieved via Bright Data", bright_data_cached: "Cached via Bright Data", curated: "Curated reference" };
  return <div id="research"><Card title="Research library" aside={
    <button className="btn btn-ghost btn-sm" onClick={() => setReload(value => value + 1)}>Refresh</button>}>
    <ConditionAbout revision={reload} />
    {error && <p className="error" role="alert">{error}</p>}
    {data?.studies.length ? <ul className="resources">{data.studies.map(study => <li className="resource" key={study.id}>
      <span className="small muted">{study.topic}</span>
      <a className="resource-title" href={study.url} target="_blank" rel="noreferrer">{study.title} ↗</a>
      <span className="small muted">{[study.authors, study.journal, study.year].filter(Boolean).join(" · ")}</span>
      <p>{study.summary}</p>
      <span className="resource-meta small">{source[study.provenance]}{study.retrievedAt ? " · " + new Date(study.retrievedAt).toLocaleDateString("en-US") : ""}</span>
    </li>)}</ul> : !error && <p className="monitor-note">{data ? "No studies available." : "Loading studies…"}</p>}
  </Card></div>;
}
