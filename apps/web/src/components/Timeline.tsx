import { useEffect, useRef, useState } from "react";
import { fitCanvas, readTokens, useDrawLoop } from "../lib/canvas";
import { formatSessionTime } from "../lib/format";
import { QUALITY_TEXT, type SessionRecorder } from "../lib/session";
import type { EventMarker, QualityLabel, TimelinePoint } from "../lib/types";

const TOKENS = ["surface-2", "grid", "text-secondary", "text-muted", "series-audio", "series-activity",
  "series-manual", "status-good", "status-warning", "status-serious", "status-critical"] as const;
type Tok = Record<(typeof TOKENS)[number], string>;

const GUTTER = 92;          // CSS px for track labels
const DB_LO = -100, DB_HI = 0;
// CSS-px track layout (top, height)
const TRACKS = {
  level: { y: 8, h: 112 },
  activity: { y: 132, h: 16 },
  markers: { y: 156, h: 16 },
  quality: { y: 180, h: 12 },
  motion: { y: 200, h: 16 },
};
export const TIMELINE_HEIGHT = 224;

const qualityToken = (q: QualityLabel): keyof Tok =>
  q === "ok" ? "status-good" : q === "no_signal" ? "status-critical" : q === "clipping" ? "status-serious" : "status-warning";

interface Hover { x: number; t: number; point: TimelinePoint | null; markers: EventMarker[] }

export function Timeline({ recorder, tick, motionConnected }: {
  recorder: SessionRecorder | null; tick: number; motionConnected: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [mode, setMode] = useState<"full" | "last30">("full");
  const [hover, setHover] = useState<Hover | null>(null);

  const range = (): [number, number] => {
    const end = Math.max(recorder?.elapsedMs ?? 0, 1000);
    return mode === "last30" ? [Math.max(0, end - 30_000), end] : [0, end];
  };

  const markDirty = useDrawLoop(() => {
    const c = canvas.current;
    if (!c) return;
    fitCanvas(c);
    const dpr = window.devicePixelRatio || 1;
    const ctx = c.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const W = c.width / dpr;
    const t = readTokens(c, TOKENS) as Tok;
    ctx.clearRect(0, 0, W, TIMELINE_HEIGHT);
    ctx.font = "11px ui-sans-serif, system-ui, sans-serif";
    ctx.textBaseline = "middle";

    const [t0, t1] = range();
    const plotW = W - GUTTER - 8;
    const xOf = (ms: number) => GUTTER + ((ms - t0) / (t1 - t0)) * plotW;
    const yOf = (db: number) => TRACKS.level.y + (1 - (Math.min(DB_HI, Math.max(DB_LO, db)) - DB_LO) / (DB_HI - DB_LO)) * TRACKS.level.h;

    // Track labels (text tokens, never series colours)
    ctx.fillStyle = t["text-secondary"];
    const label = (s: string, y: number) => ctx.fillText(s, 8, y);
    label("Audio level", TRACKS.level.y + 10);
    label("Activity", TRACKS.activity.y + TRACKS.activity.h / 2);
    label("Markers", TRACKS.markers.y + TRACKS.markers.h / 2);
    label("Quality", TRACKS.quality.y + TRACKS.quality.h / 2);
    label("Motion", TRACKS.motion.y + TRACKS.motion.h / 2);

    // Level grid + dB labels
    ctx.strokeStyle = t.grid;
    ctx.lineWidth = 1;
    ctx.fillStyle = t["text-muted"];
    ctx.textAlign = "right";
    for (const db of [-80, -60, -40, -20, 0]) {
      const y = Math.round(yOf(db)) + 0.5;
      ctx.beginPath(); ctx.moveTo(GUTTER, y); ctx.lineTo(GUTTER + plotW, y); ctx.stroke();
      ctx.fillText(`${db}`, GUTTER - 6, y);
    }
    ctx.textAlign = "left";
    // Lane backgrounds
    ctx.fillStyle = t["surface-2"];
    for (const k of ["activity", "markers", "quality", "motion"] as const) ctx.fillRect(GUTTER, TRACKS[k].y, plotW, TRACKS[k].h);

    if (!recorder || !recorder.points.length) {
      ctx.fillStyle = t["text-muted"];
      ctx.fillText(recorder ? "Waiting for audio frames…" : "Start a session to build the timeline.", GUTTER + 8, TRACKS.level.y + TRACKS.level.h / 2);
    }

    if (recorder) {
      const pts = recorder.points;
      let lo = 0, hi = pts.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (pts[m].t_ms < t0) lo = m + 1; else hi = m; }
      const visible = pts.slice(Math.max(0, lo - 1));

      // Quality strip
      for (let i = 0; i < visible.length; i++) {
        const p = visible[i];
        const next = visible[i + 1]?.t_ms ?? p.t_ms + 50;
        ctx.fillStyle = t[qualityToken(p.stable_quality)];
        ctx.fillRect(xOf(p.t_ms), TRACKS.quality.y, Math.max(1, xOf(next) - xOf(p.t_ms)), TRACKS.quality.h);
      }

      // Noise floor (dashed, muted) then level line (2px, series colour)
      const path = (key: "rms_dbfs" | "noise_floor_dbfs") => {
        ctx.beginPath();
        visible.forEach((p, i) => (i ? ctx.lineTo(xOf(p.t_ms), yOf(p[key])) : ctx.moveTo(xOf(p.t_ms), yOf(p[key]))));
        ctx.stroke();
      };
      ctx.save();
      ctx.beginPath(); ctx.rect(GUTTER, 0, plotW, TIMELINE_HEIGHT); ctx.clip();
      ctx.lineJoin = "round";
      ctx.setLineDash([4, 4]); ctx.lineWidth = 1.5; ctx.strokeStyle = t["text-muted"]; path("noise_floor_dbfs");
      ctx.setLineDash([]); ctx.lineWidth = 2; ctx.strokeStyle = t["series-audio"]; path("rms_dbfs");

      // Activity segments (rounded, 2px gap via inset)
      const segs = recorder.markers.filter((m) => m.kind === "audio_activity")
        .map((m) => ({ s: m.t_ms, e: m.t_ms + (m.duration_ms ?? 0) }));
      const cur = recorder.currentActivity;
      if (cur) segs.push({ s: cur.start_ms, e: cur.end_ms });
      ctx.fillStyle = t["series-activity"];
      for (const { s, e } of segs) {
        if (e < t0) continue;
        const x = xOf(s) + 1, w = Math.max(3, xOf(e) - xOf(s) - 2);
        ctx.beginPath(); ctx.roundRect(x, TRACKS.activity.y + 2, w, TRACKS.activity.h - 4, 4); ctx.fill();
      }

      // Manual markers: vertical guide through the level track + flag in the marker lane
      for (const m of recorder.markers) {
        if ((m.kind !== "manual" && m.kind !== "possible_swallow_event") || m.t_ms < t0) continue;
        const markerColor = m.kind === "manual" ? t["series-manual"] : t["series-activity"];
        const x = Math.round(xOf(m.t_ms)) + 0.5;
        ctx.strokeStyle = markerColor; ctx.lineWidth = 1; ctx.setLineDash([2, 3]);
        ctx.beginPath(); ctx.moveTo(x, TRACKS.level.y); ctx.lineTo(x, TRACKS.markers.y); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = markerColor;
        ctx.beginPath(); ctx.moveTo(x, TRACKS.markers.y + 2); ctx.lineTo(x + 9, TRACKS.markers.y + 8);
        ctx.lineTo(x, TRACKS.markers.y + 14); ctx.closePath(); ctx.fill();
      }
      ctx.restore();
    }

    const motionPts = recorder?.motionPoints ?? [];
    if (motionPts.length) {
      ctx.save();
      ctx.beginPath(); ctx.rect(GUTTER, TRACKS.motion.y, plotW, TRACKS.motion.h); ctx.clip();
      // Movement-interference episodes: warning-coloured spans; movement score as a thin line.
      const spans = (recorder?.markers ?? []).filter((m) => m.kind === "movement_interference")
        .map((m) => ({ s: m.t_ms, e: m.t_ms + (m.duration_ms ?? 0) }));
      const cur = recorder?.currentInterference;
      if (cur) spans.push({ s: cur.start_ms, e: cur.end_ms });
      ctx.fillStyle = t["status-warning"];
      for (const { s, e } of spans) {
        if (e < t0) continue;
        ctx.beginPath(); ctx.roundRect(xOf(s) + 1, TRACKS.motion.y + 2, Math.max(3, xOf(e) - xOf(s) - 2), TRACKS.motion.h - 4, 4); ctx.fill();
      }
      ctx.strokeStyle = t["text-secondary"]; ctx.lineWidth = 1.5;
      ctx.beginPath();
      motionPts.filter((p) => p.t_ms >= t0 - 1000).forEach((p, i) => {
        const yv = TRACKS.motion.y + TRACKS.motion.h - 2 - Math.min(1.5, p.score) / 1.5 * (TRACKS.motion.h - 4);
        if (i) ctx.lineTo(xOf(p.t_ms), yv); else ctx.moveTo(xOf(p.t_ms), yv);
      });
      ctx.stroke();
      ctx.restore();
    } else {
      ctx.fillStyle = t["text-muted"];
      ctx.fillText(motionConnected ? "Waiting for motion data…" : "MPU-6050 not connected: no motion data", GUTTER + 8, TRACKS.motion.y + TRACKS.motion.h / 2);
    }

    // Time axis ticks
    ctx.textAlign = "center";
    const span = t1 - t0;
    const step = [1000, 2000, 5000, 10_000, 30_000, 60_000, 120_000, 300_000].find((s) => span / s <= 8) ?? 600_000;
    for (let ms = Math.ceil(t0 / step) * step; ms <= t1; ms += step) {
      ctx.fillText(formatSessionTime(ms).replace(/\.\d$/, ""), xOf(ms), TIMELINE_HEIGHT - 2);
    }
    ctx.textAlign = "left";

    if (hover) {
      ctx.strokeStyle = t["text-secondary"]; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(hover.x + 0.5, TRACKS.level.y); ctx.lineTo(hover.x + 0.5, TRACKS.motion.y + TRACKS.motion.h); ctx.stroke();
      if (hover.point) {
        ctx.fillStyle = t["series-audio"];
        ctx.strokeStyle = t["surface-2"]; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(xOf(hover.point.t_ms), yOf(hover.point.rms_dbfs), 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      }
    }
  });

  useEffect(() => { markDirty(); }, [tick, mode, hover, recorder, motionConnected, markDirty]);

  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!recorder || !recorder.points.length) return setHover(null);
    const r = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - r.left;
    const plotW = r.width - GUTTER - 8;
    if (x < GUTTER) return setHover(null);
    const [t0, t1] = range();
    const tm = t0 + ((x - GUTTER) / plotW) * (t1 - t0);
    const pts = recorder.points;
    let lo = 0, hi = pts.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (pts[m].t_ms < tm) lo = m + 1; else hi = m; }
    const tol = ((t1 - t0) / plotW) * 6;
    const near = recorder.markers.filter((m) => tm >= m.t_ms - tol && tm <= m.t_ms + (m.duration_ms ?? 0) + tol);
    setHover({ x, t: tm, point: pts[lo] ?? null, markers: near });
  };

  return (
    <figure className="viz">
      <div className="viz-head">
        <figcaption>Session timeline <span className="muted">· audio + motion</span></figcaption>
        <div className="seg" role="group" aria-label="Timeline window">
          <button className={mode === "full" ? "on" : ""} onClick={() => setMode("full")}>Full session</button>
          <button className={mode === "last30" ? "on" : ""} onClick={() => setMode("last30")}>Last 30 s</button>
        </div>
      </div>
      <div className="viz-body">
        <canvas ref={canvas} style={{ height: TIMELINE_HEIGHT }} className="canvas-timeline"
          onPointerMove={onMove} onPointerLeave={() => setHover(null)}
          role="img" aria-label="Session timeline: audio level, activity segments, markers, signal quality and motion" />
        {hover && hover.point && (
          <div className="tooltip" style={{ left: hover.x, top: 12 }}>
            <strong className="tabular">{formatSessionTime(hover.point.t_ms)}</strong>
            <span className="tabular">Level {hover.point.rms_dbfs.toFixed(1)} dBFS</span>
            <span className="tabular muted">Floor {hover.point.noise_floor_dbfs.toFixed(1)} dBFS</span>
            <span>{QUALITY_TEXT[hover.point.stable_quality]}{hover.point.activity ? " · activity" : ""}</span>
            {hover.markers.map((m) => <span key={m.id} className="muted">{m.label}{m.note ? `: ${m.note}` : ""}</span>)}
          </div>
        )}
      </div>
      <div className="legend">
        <span><i className="sw line" style={{ background: "var(--series-audio)" }} />RMS level</span>
        <span><i className="sw dash" />Noise floor</span>
        <span><i className="sw" style={{ background: "var(--series-activity)" }} />Audio activity (experimental)</span>
        <span><i className="sw flag" style={{ background: "var(--series-manual)" }} />Manual marker</span>
        <span><i className="sw flag" style={{ background: "var(--series-activity)" }} />Audio + motion candidate</span>
        <span><i className="sw" style={{ background: "var(--status-good)" }} />OK</span>
        <span><i className="sw" style={{ background: "var(--status-warning)" }} />Hum</span>
        <span><i className="sw" style={{ background: "var(--status-serious)" }} />Clipping</span>
        <span><i className="sw" style={{ background: "var(--status-critical)" }} />No signal</span>
        <span><i className="sw line" style={{ background: "var(--text-secondary)" }} />Movement score</span>
        <span><i className="sw" style={{ background: "var(--status-warning)" }} />Movement interference</span>
      </div>
    </figure>
  );
}
