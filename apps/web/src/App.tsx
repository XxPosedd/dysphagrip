import { useCallback, useEffect, useRef, useState } from "react";
import { Spectrogram } from "./components/Spectrogram";
import { Timeline } from "./components/Timeline";
import { Waveform } from "./components/Waveform";
import { Chip, MarkerList, MotionPanel, QualityPanel, SessionHistory, SummaryView, VoicePanel, type DbState, type LocalSession } from "./components/Panels";
import { useAudioService } from "./hooks/useAudioService";
import { useVoice } from "./hooks/useVoice";
import { api } from "./lib/api";
import { formatDuration } from "./lib/format";
import { SessionRecorder, buildSessionPayload, describeSource } from "./lib/session";
import type { ApiHealth, QualityLabel, SessionSummary, StoredSession } from "./lib/types";

const QUALITY_VOICE: Record<Exclude<QualityLabel, "ok">, string> = {
  no_signal: "No audio signal. Check the sensor connection.",
  clipping: "Audio input is clipping. Reduce the gain.",
  mains_hum: "Electrical hum detected. Check the cable and grounding.",
};

export default function App() {
  const audio = useAudioService();
  const voice = useVoice(true);
  const voiceRef = useRef(voice);
  voiceRef.current = voice;   // listeners registered on the recorder always use the current toggle state
  const [health, setHealth] = useState<ApiHealth | null>(null);
  const [apiDown, setApiDown] = useState(false);

  const [device, setDevice] = useState<number | null>(null);
  const [channel, setChannel] = useState(0);

  const recorderRef = useRef<SessionRecorder | null>(null);
  const [recorder, setRecorder] = useState<SessionRecorder | null>(null);
  const [tick, setTick] = useState(0);
  const [lastSummary, setLastSummary] = useState<SessionSummary | null>(null);
  const [localSessions, setLocalSessions] = useState<LocalSession[]>([]);
  const [remoteSessions, setRemoteSessions] = useState<StoredSession[]>([]);
  const [db, setDb] = useState<DbState>("unknown");
  const [remoteError, setRemoteError] = useState<string | null>(null);

  const running = audio.status?.running ?? false;
  const source = audio.status?.source ?? null;
  const recording = recorder?.running ?? false;

  // ---- API health + session history ----
  const loadHealth = useCallback(async () => {
    try {
      const h = await api.health();
      setHealth(h);
      setApiDown(false);
      if (!h.integrations.database) { setDb("not_configured"); return; }
      try { await api.dbStatus(); setDb("ok"); } catch { setDb("unreachable"); }
    } catch { setHealth(null); setApiDown(true); setDb("unknown"); }
  }, []);
  const loadSessions = useCallback(async () => {
    try { setRemoteSessions((await api.sessions()).sessions); setRemoteError(null); }
    catch (e) { setRemoteSessions([]); setRemoteError((e as Error).message); }
  }, []);
  useEffect(() => {
    void loadHealth();
    const id = setInterval(loadHealth, 15_000);
    return () => clearInterval(id);
  }, [loadHealth]);
  useEffect(() => { if (db === "ok") void loadSessions(); }, [db, loadSessions]);

  // ---- Device selection defaults: running device > detected UM2 > system default ----
  useEffect(() => {
    if (source?.device_index !== undefined) { setDevice(source.device_index); setChannel(source.channel ?? 0); return; }
    if (device !== null || !audio.devices.length) return;
    const def = audio.um2Candidate ?? audio.devices.find((d) => d.is_default)?.index ?? audio.devices[0].index;
    setDevice(def);
    // UM2: the contact pickup is expected on input 2 (ch 1). Confirm with `probe`.
    setChannel(audio.um2Candidate !== null ? 1 : 0);
  }, [audio.devices, audio.um2Candidate, source?.device_index, source?.channel, device]);
  const selected = audio.devices.find((d) => d.index === device);

  // ---- Feed frames into the active session ----
  useEffect(() => audio.subscribe((f) => recorderRef.current?.ingest(f)), [audio.subscribe]);
  useEffect(() => {
    if (!recording) return;
    const id = setInterval(() => setTick((t) => t + 1), 200);
    return () => clearInterval(id);
  }, [recording]);

  // Audio input dropped mid-session: announce it (the session keeps running; the timeline shows the gap).
  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running && recorderRef.current?.running) voiceRef.current.announce("Audio input stopped.");
    wasRunning.current = running;
  }, [running]);

  const startSession = async () => {
    let status = audio.status;
    if (!status?.running) {
      status = await audio.start(device, channel);
      if (!status?.running) return;
    }
    const rec = new SessionRecorder(Date.now(), status.source);
    rec.onQualityChange.push((label, prev) => {
      if (label === "ok") { if (prev === null || prev === "no_signal") voiceRef.current.announce("Audio signal detected."); }
      else voiceRef.current.announce(QUALITY_VOICE[label]);
    });
    recorderRef.current = rec;
    setRecorder(rec);
    setLastSummary(null);
    voice.announce("Recording started.");
  };

  const saveLocal = useCallback(async (entry: LocalSession) => {
    setLocalSessions((all) => all.map((x) => (x.id === entry.id ? { ...x, save: "saving", error: undefined } : x)));
    try {
      await api.saveSession(entry.payload);
      setLocalSessions((all) => all.map((x) => (x.id === entry.id ? { ...x, save: "saved" } : x)));
      voiceRef.current.announce("Session saved successfully.");
      void loadSessions();
    } catch (e) {
      const message = (e as Error).message;
      setLocalSessions((all) => all.map((x) => (x.id === entry.id ? { ...x, save: "failed", error: `Not saved: ${message}` } : x)));
      voiceRef.current.announce("Session could not be saved.");
    }
  }, [loadSessions]);

  const stopSession = async () => {
    const rec = recorderRef.current;
    if (!rec || !rec.running) return;
    const summary = rec.stop(Date.now());
    setTick((t) => t + 1);
    setLastSummary(summary);
    const label = `Session ${new Date(summary.started_at).toLocaleTimeString()} · ${summary.audio_source}`;
    const payload = buildSessionPayload(label, summary, rec.markers, false);
    const entry: LocalSession = { id: summary.started_at, label: payload.label, summary, payload, save: "unsaved" };
    setLocalSessions((s) => [entry, ...s]);
    voiceRef.current.announce("Recording stopped.");
    if (db === "ok") await saveLocal(entry);
  };

  const retrySave = (id: string) => {
    const entry = localSessions.find((s) => s.id === id);
    if (entry) void saveLocal(entry);
  };

  const deleteRemote = async (id: string) => {
    await api.deleteSession(id);
    setRemoteSessions((all) => all.filter((s) => s.id !== id));
  };

  const addMarker = useCallback(() => {
    const rec = recorderRef.current;
    if (!rec?.running) return;
    rec.addManualMarker(Date.now() - rec.startedAtUnixMs);
    setTick((t) => t + 1);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || e.metaKey || e.ctrlKey) return;
      if (e.key === "m" || e.key === "M") { e.preventDefault(); addMarker(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [addMarker]);

  const elapsed = recorder ? (recorder.running ? Date.now() - recorder.startedAtUnixMs : recorder.elapsedMs) : 0;
  const liveBadge = !running ? <Chip tone="neutral">Input stopped</Chip>
    : source?.kind === "file" ? <Chip tone="info">File playback · not live</Chip>
    : <Chip tone="good">Live input</Chip>;
  const integ = (ok: boolean | undefined, name: string, phase: string) =>
    apiDown ? <Chip tone="neutral" title="Express API unreachable">{name}: API offline</Chip>
      : <Chip tone={ok ? "good" : "neutral"} title={ok ? "Configured on the server" : `Not configured (${phase})`}>{name}</Chip>;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="logo" aria-hidden>
            <svg viewBox="0 0 24 24" width="22" height="22"><path d="M2 12h4l2-6 4 12 3-9 2 3h5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </div>
          <div>
            <h1>DysphaGrip</h1>
            <p className="muted small">Experimental swallowing-signal monitor</p>
          </div>
        </div>
        <div className="chips" aria-label="System status">
          <Chip tone={audio.connection === "open" ? "good" : "critical"}>Audio service{audio.connection === "open" ? "" : " offline"}</Chip>
          <Chip tone="neutral" title="Firmware and receiver arrive in Phase 3">Motion: not connected</Chip>
          {apiDown ? integ(false, "Neon", "")
            : <Chip tone={db === "ok" ? "good" : db === "unreachable" ? "critical" : "neutral"}
                title={db === "not_configured" ? "Set DATABASE_URL in .env" : db === "unreachable" ? "DATABASE_URL is set but Neon did not respond" : "Connected"}>
                {db === "unreachable" ? "Neon unreachable" : "Neon"}</Chip>}
          {integ(health?.integrations.elevenlabs, "ElevenLabs", "Phase 7")}
          {integ(health?.integrations.brightdata, "Bright Data", "Phase 8")}
        </div>
      </header>

      <p className="disclaimer"><strong>Research prototype, not a medical device.</strong> DysphaGrip shows experimental
        signal features only. It does not diagnose dysphagia, does not detect aspiration or residue, and cannot confirm that
        swallowing is safe.</p>

      <section className="controls card">
        <div className="control-group">
          <label>Audio input
            <select value={device ?? ""} disabled={running || !audio.devices.length}
              onChange={(e) => { setDevice(Number(e.target.value)); setChannel(0); }}>
              {!audio.devices.length && <option value="">No devices (is the audio service running?)</option>}
              {audio.devices.map((d) => (
                <option key={d.index} value={d.index}>
                  {d.name}{d.um2_match === "strong" ? " ★ UM2" : d.um2_match === "possible" ? " ☆ possible UM2" : ""}
                  {d.hostapi ? ` · ${d.hostapi}` : ""}{d.is_default ? " (default)" : ""}
                </option>
              ))}
            </select>
          </label>
          <label>Channel
            <select value={channel} disabled={running || !selected} onChange={(e) => setChannel(Number(e.target.value))}>
              {Array.from({ length: selected?.max_input_channels ?? 1 }, (_, c) => (
                <option key={c} value={c}>Input {c + 1}{selected?.um2_match && c === 1 ? " · instrument (Hi-Z)" : ""}</option>
              ))}
            </select>
          </label>
          {running
            ? <button className="btn btn-ghost" disabled={audio.busy || recording} onClick={() => void audio.stop()}
                title={recording ? "Stop the session first" : undefined}>Stop input</button>
            : <button className="btn btn-ghost" disabled={audio.busy || device === null} onClick={() => void audio.start(device, channel)}>Start input</button>}
          <button className="btn btn-ghost btn-icon" onClick={() => void audio.refreshDevices()} title="Refresh device list" aria-label="Refresh device list">↻</button>
        </div>
        <div className="control-group session">
          {liveBadge}
          <div className={`timer tabular ${recording ? "rec" : ""}`} aria-label="Session time">
            {recording && <span className="rec-dot" aria-hidden />}{formatDuration(elapsed)}
          </div>
          {recording
            ? <button className="btn btn-stop" onClick={() => void stopSession()}>Stop session</button>
            : <button className="btn btn-primary" disabled={audio.busy || audio.connection !== "open" || device === null}
                onClick={() => void startSession()}>Start session</button>}
        </div>
      </section>

      {source && <p className="source-line muted small tabular">{describeSource(source)} · {source.samplerate} Hz
        {source.hostapi ? ` · ${source.hostapi}` : ""}{source.anchor_method ? ` · clock anchor: ${source.anchor_method}` : ""}
        {source.overflows ? ` · ${source.overflows} overflows` : ""}</p>}
      {audio.error && <div className="banner-error" role="alert">{audio.error}</div>}

      <div className="grid-main">
        <section className="card span-live">
          <Waveform subscribe={audio.subscribe} live={running} />
          <Spectrogram subscribe={audio.subscribe} live={running} />
        </section>
        <div className="stack">
          <QualityPanel frame={audio.latest} stable={recorder?.stableQuality ?? null} />
          <MotionPanel />
        </div>
      </div>

      <section className="card">
        <Timeline recorder={recorder} tick={tick} motionConnected={false} />
        {lastSummary && !recording && (
          <div className="last-summary"><h3 className="sub">Last session summary</h3><SummaryView s={lastSummary} /></div>
        )}
      </section>

      <div className="grid-two">
        <MarkerList markers={recorder?.markers ?? []} canAdd={recording} onAdd={addMarker} />
        <VoicePanel enabled={voice.enabled} setEnabled={voice.setEnabled} state={voice.state} log={voice.log} />
      </div>

      <SessionHistory local={localSessions} remote={remoteSessions} remoteError={remoteError} db={db}
        onRefresh={() => { void loadHealth(); if (db === "ok") void loadSessions(); }}
        onRetry={retrySave} onDelete={deleteRemote} />

      <footer className="muted small">Raw audio never leaves this computer: the browser receives only waveform envelopes,
        spectrogram columns and signal features from the local audio service.</footer>
    </div>
  );
}
