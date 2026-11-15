import { useCallback, useEffect, useRef, useState } from "react";
import { Card, Chip } from "./components/Panels";
import MonitorSignals from "./components/MonitorSignals";
import { MonitorHistoryPanel, ResearchPanel } from "./components/MonitorRecords";
import { useRecordingVoice } from "./hooks/useRecordingVoice";
import { formatDuration } from "./lib/format";
import { activityName, markChoices, monitor, type MonitorStatus } from "./lib/monitor";
import { VOICE } from "./lib/voicePhrases";
import "./live-monitor.css";

function sensorState(status: MonitorStatus | null, sensor: "audio" | "imu") {
  if (status?.hardware[sensor]) return "Receiving";
  const detected = status?.devices?.[sensor];
  if (detected === false) return "Not detected";
  if (detected === true) return status?.state === "recording" || status?.state === "starting" ?
    "Detected · waiting for signal" : "Detected · idle";
  return "Status unknown";
}

export default function LiveMonitor() {
  const [status, setStatus] = useState<MonitorStatus | null>(null);
  const [offline, setOffline] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const voice = useRecordingVoice();
  const { announce, prepare } = voice;
  const [historyRevision, setHistoryRevision] = useState(0);
  const [unsaved, setUnsaved] = useState("");
  const latest = useRef<MonitorStatus | null>(null);
  const generation = useRef(0);
  const sending = useRef(false);
  const pendingVoice = useRef<"start" | "stop" | null>(null);

  const save = useCallback(async (session: string) => {
    try { await monitor.save(session); setUnsaved(""); }
    catch { setUnsaved(session); }
    setHistoryRevision(value => value + 1);
  }, []);

  const accept = useCallback((fresh: MonitorStatus) => {
    const previous = latest.current;
    latest.current = fresh;
    setStatus(fresh);
    setOffline(false);
    if (pendingVoice.current === "start" && fresh.state === "recording") {
      pendingVoice.current = null;
      void announce(VOICE.recordingStarted);
    }
    if (fresh.state === "idle" && previous && ["recording", "starting", "stopping"].includes(previous.state)) {
      if (pendingVoice.current === "stop") void announce(VOICE.recordingStopped);
      const id = fresh.session ?? previous.session;
      if (id) void save(id);
      pendingVoice.current = null;
    }
    if (fresh.state === "error") pendingVoice.current = null;
  }, [announce, save]);

  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      const requestGeneration = generation.current;
      try {
        const snapshot = await monitor.status(abort.signal);
        if (!abort.signal.aborted && requestGeneration === generation.current && !sending.current) accept(snapshot);
      } catch {
        if (!abort.signal.aborted && requestGeneration === generation.current) setOffline(true);
      } finally {
        if (!abort.signal.aborted) timer = setTimeout(poll, document.hidden ? 1200 : 300);
      }
    }
    void poll();
    return () => { abort.abort(); clearTimeout(timer); };
  }, [accept]);

  const command = useCallback(async (action: "start" | "stop" | "mark", category?: string) => {
    if (sending.current) return;
    sending.current = true;
    ++generation.current;
    setBusy(true);
    setError("");
    if (action !== "mark") {
      pendingVoice.current = action;
      prepare();
    }
    try { accept(await monitor.command(action, category)); }
    catch (failure) {
      pendingVoice.current = null;
      setError(failure instanceof Error ? failure.message : "The monitor command failed.");
    } finally { ++generation.current; sending.current = false; setBusy(false); }
  }, [accept, prepare]);

  const live = offline ? null : status;
  const recording = live?.state === "recording";
  const canStart = live?.state === "idle" || live?.state === "error";
  const canStop = live?.state === "starting" || recording;
  const canMark = Boolean(recording && live?.calibrated && live.hardware.audio && live.hardware.imu);
  useEffect(() => {
    function keypress(event: KeyboardEvent) {
      if (!canMark || busy || event.repeat || event.altKey || event.ctrlKey || event.metaKey) return;
      if ((event.target as HTMLElement)?.closest("input, textarea, select, [contenteditable=true]")) return;
      const choice = markChoices.find((_, i) => String(i + 1) === event.key);
      if (choice) { event.preventDefault(); void command("mark", choice.category); }
    }
    window.addEventListener("keydown", keypress);
    return () => window.removeEventListener("keydown", keypress);
  }, [busy, canMark, command]);

  const phase = offline ? "Monitor offline" : !live ? "Connecting" : live.state === "idle" ? "Idle" :
    live.state === "error" ? "Hardware error" : activityName(live.state);
  const activity = canMark ? live?.activity : null;
  return <main className="app field-monitor">
    <header className="topbar">
      <div className="brand"><div className="logo" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="24" height="24"><path d="M2 12h4l2-6 4 12 3-9 2 3h5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </div><div><h1>DysphaGrip</h1><p className="muted small">Experimental swallowing-signal monitor</p></div></div>
      <nav aria-label="Dashboard sections"><a href="#signals">Signals</a><a href="#history">Sessions</a><a href="#research">Research</a></nav>
    </header>

    <section id="signals" className="card monitor-toolbar" aria-label="Recording controls">
      <div><h2>Live monitor</h2>
        <div className="monitor-badges"><Chip tone={offline || live?.state === "error" ? "critical" : recording ? "good" : "neutral"}>{phase}</Chip>
          <span className="monitor-timer">{formatDuration((live?.elapsed_seconds ?? 0) * 1000)}</span></div>
      </div>
      <div className="monitor-controls">
        <label><input type="checkbox" checked={voice.enabled} onChange={e => voice.setEnabled(e.target.checked)} /> Voice feedback{voice.provider ? " · " + voice.provider : ""}</label>
        <button className="btn btn-ghost btn-sm" disabled={!canStart || busy || voice.previewing} onClick={() => void voice.preview()}>
          {voice.previewing ? "Playing preview…" : "Preview voice"}</button>
        <button className="btn btn-primary" disabled={busy || !canStart} onClick={() => void command("start")}>{live?.state === "error" ? "Retry recording" : "Record"}</button>
        <button className="btn btn-stop" disabled={busy || !canStop} onClick={() => void command("stop")}>Stop</button>
      </div>
    </section>
    {(error || live?.error || offline) && <p className="banner-error" role="alert">{error || live?.error || "The local monitor is offline. Start the workstation monitor to connect the sensors."}</p>}
    {live?.state === "error" && live.devices?.audio && live.devices.imu &&
      <p className="disclaimer" role="status">Both devices are detected. Select Retry recording when ready.</p>}
    {voice.error && <p className="error" role="status">{voice.error}</p>}
    {unsaved && <div className="banner-error" role="status">The recording is on the workstation. History sync failed.{" "}
      <button className="btn btn-ghost btn-sm" onClick={() => void save(unsaved)}>Retry sync</button></div>}

    <div className="grid-main">
      <MonitorSignals status={recording ? live : null}/>
      <div className="stack">
        <Card title="Activity estimate">
          <div className="activity-name">{activity ? activityName(activity.label) : recording ?
            (live?.calibrated ? "Waiting for signal" : "Calibrating…") : "Waiting for recording"}</div>
          {typeof activity?.score === "number" && activity.raw_label === activity.label &&
            <span className="small muted">Model score · {activity.score.toFixed(2)}</span>}
          <div className="sensor-list"><div><span>Contact microphone</span><strong>{sensorState(live, "audio")}</strong></div>
            <div><span>MPU6050 motion</span><strong>{sensorState(live, "imu")}</strong></div></div>
          <p className="small muted">Estimates describe observed activity. Swallowing safety requires clinical assessment.</p>
        </Card>
        <Card title="Manual marks" aside={<span className="muted small">{live?.marks ?? 0} saved</span>}>
          <p className="small muted">{recording && !live?.calibrated ? "Keep the sensors still during calibration." : "Press a number key or select an action just after it occurs."}</p>
          <div className="monitor-marks">{markChoices.map((choice, i) => <button key={choice.category} className="btn btn-ghost"
            disabled={busy || !canMark} onClick={() => void command("mark", choice.category)}><kbd>{i + 1}</kbd>{choice.name}</button>)}</div>
          {live?.last_mark && <p role="status" className="small">Last mark · #{live.last_mark.id} {activityName(live.last_mark.category)}</p>}
        </Card>
        <div className="card monitor-count"><span>Candidate events</span><strong>{live?.event_count ?? "—"}</strong></div>
      </div>
    </div>
    <MonitorHistoryPanel revision={historyRevision}/>
    <ResearchPanel/>
  </main>;
}
