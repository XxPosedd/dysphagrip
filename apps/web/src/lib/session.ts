import { ActivitySegmenter, QualityDebouncer } from "./events";
import type { AudioFrame, AudioSourceInfo, EventMarker, MotionFrame, QualityLabel, SessionPayload, SessionSummary, StoredSession, TimelinePoint } from "./types";

export const QUALITY_TEXT: Record<QualityLabel, string> = {
  ok: "Signal OK",
  no_signal: "No signal",
  clipping: "Clipping",
  mains_hum: "Mains hum",
};

let idCounter = 0;
const newId = () => `${Date.now().toString(36)}-${(idCounter++).toString(36)}`;

export function describeSource(src: AudioSourceInfo | null): string {
  if (!src) return "unknown";
  if (src.kind === "file") return `file playback: ${src.file ?? "?"}`;
  const name = src.um2_match === "strong" ? "Behringer UM2" : src.device_name ?? "audio input";
  return `${name} · ch ${src.channel ?? 0}`;
}

/**
 * Accumulates one recording session from audio frames. Pure (no React, no DOM), so it
 * is unit-tested directly. Time is session-relative ms derived from the audio sample
 * clock (frame.t_end_unix_ms) when available.
 */
export class SessionRecorder {
  readonly startedAtUnixMs: number;
  endedAtUnixMs: number | null = null;
  readonly points: TimelinePoint[] = [];
  readonly markers: EventMarker[] = [];
  readonly onMarker: Array<(m: EventMarker) => void> = [];
  /** Called when the debounced (>= 1 s stable) quality label changes; `previous` is null for the first label. */
  readonly onQualityChange: Array<(label: QualityLabel, previous: QualityLabel | null) => void> = [];
  /** Called when a movement-interference episode starts (for the voice cue). */
  readonly onMovementStart: Array<() => void> = [];
  /** Motion timeline: one point per motion frame (session ms, movement score, interference). */
  readonly motionPoints: Array<{ t_ms: number; score: number; interference: boolean }> = [];
  motionSamples = 0;
  private interferenceSince: number | null = null;

  private segmenter = new ActivitySegmenter();
  private quality = new QualityDebouncer();
  private qualityEpisode: { label: QualityLabel; start: number } | null = null;
  private qualityMs: Record<QualityLabel, number> = { ok: 0, no_signal: 0, clipping: 0, mains_hum: 0 };
  private lastT = 0;
  private frames = 0;
  private dropped = 0;
  private maxRms = -Infinity;

  constructor(startUnixMs: number, readonly source: AudioSourceInfo | null, private maxPoints = 72_000) {
    this.startedAtUnixMs = startUnixMs;
  }

  get elapsedMs(): number {
    return (this.endedAtUnixMs ?? this.startedAtUnixMs + this.lastT) - this.startedAtUnixMs;
  }

  get running(): boolean {
    return this.endedAtUnixMs === null;
  }

  get currentActivity() {
    return this.segmenter.current;
  }

  get stableQuality(): QualityLabel | null {
    return this.quality.label;
  }

  ingest(frame: AudioFrame, receivedUnixMs = Date.now()): void {
    if (!this.running) return;
    const endUnix = frame.t_end_unix_ms ?? receivedUnixMs;
    const t = endUnix - this.startedAtUnixMs;
    if (t < 0) return; // frame captured before the session started
    const dt = Math.max(0, t - this.lastT);
    this.lastT = t;
    this.frames += 1;
    this.dropped += frame.dropped_samples;
    const f = frame.features;
    this.maxRms = Math.max(this.maxRms, f.rms_dbfs);
    this.qualityMs[frame.quality.label] += dt;

    const previous = this.quality.label;
    const changed = this.quality.push(t, frame.quality.label);

    if (this.points.length >= this.maxPoints) this.points.shift();
    this.points.push({ t_ms: t, rms_dbfs: f.rms_dbfs, noise_floor_dbfs: f.noise_floor_dbfs,
      activity: f.activity, quality: frame.quality.label, stable_quality: this.quality.label ?? frame.quality.label });

    const seg = this.segmenter.push(t, f.activity);
    if (seg) this.addActivityMarker(seg.start_ms, seg.end_ms);

    if (changed) {
      this.qualityTransition(changed, t);
      this.onQualityChange.forEach((fn) => fn(changed, previous));
    }
  }

  /** Ingest one motion frame (timestamps are host Unix ms from the audio service's shared clock). */
  ingestMotion(frame: MotionFrame): void {
    if (!this.running || !frame.samples.length) return;
    const t = frame.samples[frame.samples.length - 1].t_unix_ms - this.startedAtUnixMs;
    if (t < 0) return;
    this.motionSamples += frame.samples.length;
    const active = frame.features.interference === true;
    if (this.motionPoints.length >= this.maxPoints) this.motionPoints.shift();
    this.motionPoints.push({ t_ms: t, score: frame.features.movement_score ?? 0, interference: active });
    if (active && this.interferenceSince === null) {
      this.interferenceSince = frame.samples[0].t_unix_ms - this.startedAtUnixMs;
      this.onMovementStart.forEach((fn) => fn());
    } else if (!active && this.interferenceSince !== null) {
      this.closeInterference(t);
    }
  }

  get motionConnected(): boolean {
    return this.motionSamples > 0;
  }

  get currentInterference(): { start_ms: number; end_ms: number } | null {
    const last = this.motionPoints[this.motionPoints.length - 1];
    return this.interferenceSince === null || !last ? null : { start_ms: Math.max(0, this.interferenceSince), end_ms: last.t_ms };
  }

  private closeInterference(t: number) {
    if (this.interferenceSince === null) return;
    const start = Math.max(0, this.interferenceSince);
    this.interferenceSince = null;
    this.emit({ id: newId(), kind: "movement_interference", t_ms: start, duration_ms: Math.max(0, t - start),
      label: "Movement interference" });
  }

  addManualMarker(t_ms: number = this.lastT, note?: string): EventMarker {
    const m: EventMarker = { id: newId(), kind: "manual", t_ms, label: "Manual marker", note };
    this.emit(m);
    return m;
  }

  stop(endUnixMs: number): SessionSummary {
    if (this.running) {
      const t = endUnixMs - this.startedAtUnixMs;
      const seg = this.segmenter.flush(t);
      if (seg) this.addActivityMarker(seg.start_ms, seg.end_ms);
      this.closeQualityEpisode(t);
      this.closeInterference(t);
      this.endedAtUnixMs = endUnixMs;
    }
    return this.summary();
  }

  summary(): SessionSummary {
    const floors = this.points.map((p) => p.noise_floor_dbfs).sort((a, b) => a - b);
    const activity = this.markers.filter((m) => m.kind === "audio_activity");
    return {
      started_at: new Date(this.startedAtUnixMs).toISOString(),
      ended_at: this.endedAtUnixMs === null ? null : new Date(this.endedAtUnixMs).toISOString(),
      duration_ms: Math.round(this.elapsedMs),
      audio_source: describeSource(this.source),
      audio_source_kind: this.source?.kind ?? "unknown",
      frames: this.frames,
      dropped_samples: this.dropped,
      quality_ms: { ...this.qualityMs },
      activity_ms: activity.reduce((s, m) => s + (m.duration_ms ?? 0), 0),
      activity_segments: activity.length,
      manual_markers: this.markers.filter((m) => m.kind === "manual").length,
      median_noise_floor_dbfs: floors.length ? floors[Math.floor(floors.length / 2)] : null,
      max_rms_dbfs: Number.isFinite(this.maxRms) ? this.maxRms : null,
    };
  }

  private addActivityMarker(start: number, end: number) {
    this.emit({ id: newId(), kind: "audio_activity", t_ms: start, duration_ms: end - start,
      label: "Audio activity (experimental)" });
  }

  private qualityTransition(label: QualityLabel, t: number) {
    this.closeQualityEpisode(t);
    if (label !== "ok") this.qualityEpisode = { label, start: t };
  }

  private closeQualityEpisode(t: number) {
    if (!this.qualityEpisode) return;
    const { label, start } = this.qualityEpisode;
    this.qualityEpisode = null;
    this.emit({ id: newId(), kind: "quality", t_ms: start, duration_ms: t - start, label: QUALITY_TEXT[label] });
  }

  private emit(m: EventMarker) {
    this.markers.push(m);
    this.markers.sort((a, b) => a.t_ms - b.t_ms);
    this.onMarker.forEach((fn) => fn(m));
  }
}

/** Payload for POST /api/sessions. Labels are truncated to the server's 120-character limit. */
export function buildSessionPayload(label: string, summary: SessionSummary, markers: EventMarker[], motionConnected = false): SessionPayload {
  return {
    label: label.slice(0, 120),
    motion_connected: motionConnected,
    summary,
    markers: markers.slice(0, 5000).map((m) => ({
      kind: m.kind,
      t_ms: Math.max(0, Math.round(m.t_ms)),
      duration_ms: m.duration_ms === undefined ? null : Math.max(0, Math.round(m.duration_ms)),
      label: m.label.slice(0, 80),
      note: m.note ? m.note.slice(0, 280) : null,
    })),
  };
}

/** Convert a stored Neon session into the summary shape the UI renders. */
export function storedToSummary(s: StoredSession): SessionSummary {
  return {
    started_at: s.started_at,
    ended_at: s.ended_at,
    duration_ms: s.duration_ms,
    audio_source: s.audio_source,
    audio_source_kind: s.audio_source_kind,
    frames: s.frames,
    dropped_samples: s.dropped_samples,
    quality_ms: s.quality_ms,
    activity_ms: s.activity_ms,
    activity_segments: s.activity_segments,
    manual_markers: s.manual_markers,
    median_noise_floor_dbfs: s.median_noise_floor_dbfs,
    max_rms_dbfs: s.max_rms_dbfs,
  };
}
