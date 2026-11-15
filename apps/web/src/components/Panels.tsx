import { useState, type ReactNode } from "react";
import { api } from "../lib/api";
import type { Announcement, VoiceInfo, VoiceState } from "../hooks/useVoice";
import { formatDuration, formatHz, formatSessionTime, pct } from "../lib/format";
import { QUALITY_TEXT, storedToSummary } from "../lib/session";
import type { AudioFrame, EventMarker, QualityLabel, SessionPayload, SessionSummary, StoredMarker, StoredSession } from "../lib/types";

// ---------- Status chip (icon + label; colour never carries meaning alone) ----------
type Tone = "good" | "warning" | "serious" | "critical" | "neutral" | "info";
const ICON: Record<Tone, string> = { good: "✓", warning: "!", serious: "!", critical: "✕", neutral: "○", info: "◆" };

export function Chip({ tone, children, title }: { tone: Tone; children: ReactNode; title?: string }) {
  return <span className={`chip chip-${tone}`} title={title}><span aria-hidden className="chip-icon">{ICON[tone]}</span>{children}</span>;
}

export function qualityTone(q: QualityLabel | null | undefined): Tone {
  if (!q) return "neutral";
  return q === "ok" ? "good" : q === "no_signal" ? "critical" : q === "clipping" ? "serious" : "warning";
}

export function Card({ title, aside, children, className = "" }: { title: string; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      <header className="card-head"><h2>{title}</h2>{aside}</header>
      {children}
    </section>
  );
}

// ---------- Signal quality + features ----------
export function QualityPanel({ frame, stable }: { frame: AudioFrame | null; stable: QualityLabel | null }) {
  const f = frame?.features;
  const label = stable ?? frame?.quality.label ?? null;
  const metric = (name: string, value: string, hint?: string) => (
    <div className="metric" title={hint}><span>{name}</span><strong className="tabular">{value}</strong></div>
  );
  return (
    <Card title="Signal quality" aside={<Chip tone={qualityTone(label)}>{label ? QUALITY_TEXT[label] : "No data"}</Chip>}>
      {frame && frame.quality.reasons.length > 0 && (
        <ul className="reasons">{frame.quality.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
      )}
      <div className="metrics">
        {metric("RMS level", f ? `${f.rms_dbfs.toFixed(1)} dBFS` : "—")}
        {metric("Noise floor", f ? `${f.noise_floor_dbfs.toFixed(1)} dBFS` : "—", "Adaptive estimate of background level")}
        {metric("Above floor", f ? `${f.snr_db.toFixed(1)} dB` : "—")}
        {metric("Activity", f ? (f.activity ? "Active" : "Quiet") : "—", "Energy ≥ 10 dB above the noise floor. Not a swallow detector.")}
        {metric("Dominant", f ? formatHz(f.dominant_hz) : "—")}
        {metric("Centroid", f ? formatHz(f.spectral_centroid_hz) : "—")}
        {metric("Mains hum", f ? pct(f.hum_ratio) : "—", "Share of 20–1000 Hz power at 50/60 Hz and harmonics")}
        {metric("Clipping", f ? pct(f.clip_fraction, 2) : "—")}
      </div>
      {f && (
        <div className="bands" aria-label="Energy by frequency band">
          {(["low", "mid", "high"] as const).map((b) => (
            <div key={b} className="band">
              <span>{b === "low" ? "20–250 Hz" : b === "mid" ? "250 Hz–1 kHz" : "1–4 kHz"}</span>
              <div className="bar"><div style={{ width: pct(f.band_fraction[b]) }} /></div>
              <strong className="tabular">{pct(f.band_fraction[b])}</strong>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// ---------- Event markers ----------
const KIND_TEXT: Record<EventMarker["kind"], string> = { manual: "Manual", audio_activity: "Activity", quality: "Quality",
  movement_interference: "Movement" };

export function MarkerList({ markers, canAdd, onAdd }: { markers: EventMarker[]; canAdd: boolean; onAdd: () => void }) {
  const list = [...markers].reverse();
  return (
    <Card title="Event markers" aside={<button className="btn btn-sm" disabled={!canAdd} onClick={onAdd}
      title="Keyboard shortcut: M">+ Mark event <kbd>M</kbd></button>}>
      <p className="muted small">Experimental signal events. Activity markers mean "audio energy above the noise
        floor"; movement markers mean the sensor mount moved. Neither is a swallow or any clinical finding.</p>
      {list.length === 0 ? <p className="empty">No markers yet.</p> : (
        <ol className="markers">
          {list.slice(0, 50).map((m) => (
            <li key={m.id}>
              <span className={`kind kind-${m.kind}`}>{KIND_TEXT[m.kind]}</span>
              <span className="tabular">{formatSessionTime(m.t_ms)}</span>
              <span className="grow">{m.label}{m.note ? `: ${m.note}` : ""}</span>
              {m.duration_ms !== undefined && <span className="muted tabular">{(m.duration_ms / 1000).toFixed(1)} s</span>}
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

// ---------- Session summary + history ----------
export function SummaryView({ s }: { s: SessionSummary }) {
  const total = Math.max(1, Object.values(s.quality_ms).reduce((a, b) => a + b, 0));
  return (
    <div className="summary">
      <div className="metrics">
        <div className="metric"><span>Duration</span><strong className="tabular">{formatDuration(s.duration_ms)}</strong></div>
        <div className="metric"><span>Activity segments</span><strong className="tabular">{s.activity_segments}</strong></div>
        <div className="metric"><span>Manual markers</span><strong className="tabular">{s.manual_markers}</strong></div>
        <div className="metric"><span>Median floor</span><strong className="tabular">{s.median_noise_floor_dbfs?.toFixed(1) ?? "—"} dBFS</strong></div>
      </div>
      <div className="qbar" aria-label="Time by signal quality">
        {(Object.keys(s.quality_ms) as QualityLabel[]).filter((k) => s.quality_ms[k] > 0).map((k) => (
          <div key={k} style={{ flexGrow: s.quality_ms[k] / total }} className={`q-${k}`}
            title={`${QUALITY_TEXT[k]}: ${pct(s.quality_ms[k] / total)}`} />
        ))}
      </div>
      <p className="muted small">Source: {s.audio_source}{s.dropped_samples ? ` · ${s.dropped_samples} samples dropped` : ""}</p>
    </div>
  );
}

export type SaveState = "unsaved" | "saving" | "saved" | "failed";
export interface LocalSession { id: string; label: string; summary: SessionSummary; payload: SessionPayload; save: SaveState; error?: string }
export type DbState = "unknown" | "not_configured" | "ok" | "unreachable";

function RemoteSessionItem({ s, onDelete }: { s: StoredSession; onDelete: (id: string) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [markers, setMarkers] = useState<StoredMarker[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const toggle = async () => {
    setOpen((o) => !o);
    if (markers || open) return;
    try {
      setMarkers((await api.session(s.id)).session.markers);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const remove = async () => {
    if (!window.confirm(`Delete "${s.label}" from Neon? This permanently removes the session, its markers and quality summary.`)) return;
    setBusy(true);
    try { await onDelete(s.id); } catch (e) { setError((e as Error).message); setBusy(false); }
  };

  return (
    <li>
      <div className="history-head">
        <strong>{s.label}</strong>
        <span className="muted tabular">{new Date(s.started_at).toLocaleString()}</span>
        <Chip tone="good">Saved in Neon</Chip>
        <span className="grow" />
        <button className="btn btn-sm btn-ghost" onClick={() => void toggle()} aria-expanded={open}>
          {open ? "Hide markers" : "Show markers"}</button>
        <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => void remove()}>Delete</button>
      </div>
      <SummaryView s={storedToSummary(s)} />
      {error && <p className="error">{error}</p>}
      {open && (markers === null ? <p className="muted small">Loading markers…</p> : markers.length === 0
        ? <p className="empty">No markers in this session.</p>
        : <ol className="markers compact">{markers.map((m, i) => (
            <li key={i}>
              <span className={`kind kind-${m.kind}`}>{KIND_TEXT[m.kind as EventMarker["kind"]] ?? m.kind}</span>
              <span className="tabular">{formatSessionTime(m.t_ms)}</span>
              <span className="grow">{m.label}{m.note ? `: ${m.note}` : ""}</span>
              {m.duration_ms !== null && <span className="muted tabular">{(m.duration_ms / 1000).toFixed(1)} s</span>}
            </li>))}</ol>)}
    </li>
  );
}

const SAVE_CHIP: Record<SaveState, [Parameters<typeof Chip>[0]["tone"], string]> = {
  unsaved: ["neutral", "This tab only"], saving: ["info", "Saving…"], saved: ["good", "Saved"], failed: ["critical", "Save failed"],
};

export function SessionHistory({ local, remote, remoteError, db, onRefresh, onRetry, onDelete }: {
  local: LocalSession[]; remote: StoredSession[]; remoteError: string | null; db: DbState;
  onRefresh: () => void; onRetry: (id: string) => void; onDelete: (id: string) => Promise<void>;
}) {
  const pending = local.filter((s) => s.save !== "saved");
  const dbChip = db === "ok" ? <Chip tone="good">Neon connected</Chip>
    : db === "unreachable" ? <Chip tone="critical">Neon unreachable</Chip>
    : db === "not_configured" ? <Chip tone="neutral">Neon not configured</Chip> : <Chip tone="neutral">Checking Neon…</Chip>;
  return (
    <Card title="Session history" aside={<div className="row">{dbChip}<button className="btn btn-sm btn-ghost" onClick={onRefresh}>Refresh</button></div>}>
      {db === "not_configured" && <p className="muted small">Set <code>DATABASE_URL</code> in <code>.env</code> to persist sessions in Neon.
        Until then, sessions below exist only in this browser tab.</p>}
      {remoteError && db !== "not_configured" && <p className="error">{remoteError}</p>}
      {pending.length === 0 && remote.length === 0 ? <p className="empty">No sessions yet.</p> : (
        <ul className="history">
          {pending.map((s) => {
            const [tone, text] = SAVE_CHIP[s.save];
            return (
              <li key={s.id}>
                <div className="history-head">
                  <strong>{s.label}</strong>
                  <span className="muted tabular">{new Date(s.summary.started_at).toLocaleString()}</span>
                  <Chip tone={tone}>{text}</Chip>
                  <span className="grow" />
                  {(s.save === "failed" || (s.save === "unsaved" && db === "ok")) &&
                    <button className="btn btn-sm" onClick={() => onRetry(s.id)}>{s.save === "failed" ? "Retry save" : "Save to Neon"}</button>}
                </div>
                <SummaryView s={s.summary} />
                {s.error && <p className="error">{s.error}</p>}
              </li>
            );
          })}
          {remote.map((s) => <RemoteSessionItem key={s.id} s={s} onDelete={onDelete} />)}
        </ul>
      )}
    </Card>
  );
}

// ---------- Voice feedback ----------
export function VoicePanel({ enabled, setEnabled, state, log, info, lastError, onTest }: {
  enabled: boolean; setEnabled: (v: boolean) => void; state: VoiceState; log: Announcement[];
  info: VoiceInfo | null; lastError: string | null; onTest: () => void;
}) {
  const chip = state === "ready" ? <Chip tone="good">ElevenLabs</Chip>
    : state === "not_configured" ? <Chip tone="neutral">Not configured</Chip>
    : state === "api_offline" ? <Chip tone="neutral">API offline</Chip>
    : state === "error" ? <Chip tone="critical">Voice error</Chip> : <Chip tone="neutral">Checking…</Chip>;
  const voiceName = info?.voice ? (info.voice.name ?? `voice ${info.voice.id.slice(0, 6)}…`) : null;
  return (
    <Card title="Voice feedback" aside={chip}>
      <div className="row voice-controls">
        <label className="toggle"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Speak status updates</label>
        <span className="grow" />
        <button className="btn btn-sm" disabled={state !== "ready" && state !== "error"} onClick={onTest}>▶ Test voice</button>
      </div>
      {info?.configured && <p className="muted small">ElevenLabs{voiceName ? ` · ${voiceName}` : ""}{info.model_id ? ` · ${info.model_id}` : ""}.
        Fixed operational phrases only (never medical advice).</p>}
      {state === "not_configured" && <p className="muted small">ElevenLabs is not configured on the server. Add{" "}
        <code>ELEVENLABS_API_KEY</code> and <code>ELEVENLABS_VOICE_ID</code> to <code>.env</code> and restart the API.
        Status updates are shown as text only.</p>}
      {state === "error" && lastError && <p className="error">{lastError}</p>}
      <ul className="announce" aria-live="polite">
        {log.slice(0, 6).map((a) => (
          <li key={a.id}>
            <span aria-hidden title={a.delivery}>{a.delivery === "spoken" ? "🔊" : a.delivery === "pending" ? "⏳" : "💬"}</span>
            <span className="grow">{a.text}</span>
            <span className="muted small tabular">{new Date(a.at).toLocaleTimeString()}</span>
          </li>
        ))}
        {log.length === 0 && <li className="muted">No announcements yet.</li>}
      </ul>
      <p className="muted small">🔊 spoken by ElevenLabs · 💬 shown as text only</p>
    </Card>
  );
}
