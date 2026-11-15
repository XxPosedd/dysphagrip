// Validation for session payloads sent by the dashboard. Hand-written (no extra dependency) and strict:
// unknown marker kinds, non-finite numbers, oversized strings and impossible times are rejected.

export const QUALITY_LABELS = ["ok", "no_signal", "clipping", "mains_hum"] as const;
export const MARKER_KINDS = ["manual", "audio_activity", "quality", "movement_interference"] as const;
export type QualityLabel = (typeof QUALITY_LABELS)[number];
export type MarkerKind = (typeof MARKER_KINDS)[number];

export const LIMITS = {
  label: 120,
  audioSource: 200,
  markerLabel: 80,
  note: 280,
  markers: 5000,
  durationMs: 24 * 3600 * 1000,
} as const;

export interface MarkerInput {
  kind: MarkerKind;
  t_ms: number;
  duration_ms: number | null;
  label: string;
  note: string | null;
}

export interface SessionInput {
  label: string;
  started_at: string;
  ended_at: string;
  duration_ms: number;
  audio_source: string;
  audio_source_kind: "device" | "file" | "unknown";
  frames: number;
  dropped_samples: number;
  activity_ms: number;
  activity_segments: number;
  manual_markers: number;
  median_noise_floor_dbfs: number | null;
  max_rms_dbfs: number | null;
  motion_connected: boolean;
  quality_ms: Record<QualityLabel, number>;
  markers: MarkerInput[];
}

export class ValidationError extends Error {}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function str(o: Obj, key: string, max: number, opts: { optional?: boolean } = {}): string | null {
  const v = o[key];
  if (v === undefined || v === null || v === "") {
    if (opts.optional) return null;
    throw new ValidationError(`${key} is required`);
  }
  if (typeof v !== "string") throw new ValidationError(`${key} must be a string`);
  const trimmed = v.trim();
  if (trimmed.length > max) throw new ValidationError(`${key} must be at most ${max} characters`);
  if (!trimmed && !opts.optional) throw new ValidationError(`${key} is required`);
  return trimmed || null;
}

function int(o: Obj, key: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const v = o[key];
  if (typeof v !== "number" || !Number.isFinite(v)) throw new ValidationError(`${key} must be a finite number`);
  const n = Math.round(v);
  if (n < min || n > max) throw new ValidationError(`${key} out of range`);
  return n;
}

function db(o: Obj, key: string): number | null {
  const v = o[key];
  if (v === null || v === undefined) return null;
  if (typeof v !== "number" || !Number.isFinite(v) || v < -400 || v > 20) throw new ValidationError(`${key} must be a dBFS value`);
  return v;
}

function isoDate(o: Obj, key: string): string {
  const v = str(o, key, 40)!;
  const t = Date.parse(v);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(v) || Number.isNaN(t)) throw new ValidationError(`${key} must be an ISO 8601 timestamp`);
  return new Date(t).toISOString();
}

export function parseSessionInput(body: unknown): SessionInput {
  if (!isObj(body)) throw new ValidationError("Body must be a JSON object");
  const s = isObj(body.summary) ? body.summary : null;
  if (!s) throw new ValidationError("summary is required");

  const started_at = isoDate(s, "started_at");
  const ended_at = isoDate(s, "ended_at");
  if (Date.parse(ended_at) < Date.parse(started_at)) throw new ValidationError("ended_at is before started_at");

  const kind = s.audio_source_kind;
  const audio_source_kind = kind === "device" || kind === "file" ? kind : "unknown";

  const q = isObj(s.quality_ms) ? s.quality_ms : null;
  if (!q) throw new ValidationError("quality_ms is required");
  const quality_ms = Object.fromEntries(QUALITY_LABELS.map((l) => [l, q[l] === undefined ? 0 : int(q, l, 0, LIMITS.durationMs)])) as Record<QualityLabel, number>;

  const rawMarkers = body.markers ?? [];
  if (!Array.isArray(rawMarkers)) throw new ValidationError("markers must be an array");
  if (rawMarkers.length > LIMITS.markers) throw new ValidationError(`At most ${LIMITS.markers} markers per session`);
  const markers = rawMarkers.map((m, i): MarkerInput => {
    if (!isObj(m)) throw new ValidationError(`markers[${i}] must be an object`);
    if (!MARKER_KINDS.includes(m.kind as MarkerKind)) throw new ValidationError(`markers[${i}].kind is not allowed`);
    return {
      kind: m.kind as MarkerKind,
      t_ms: int(m, "t_ms", 0, LIMITS.durationMs),
      duration_ms: m.duration_ms === undefined || m.duration_ms === null ? null : int(m, "duration_ms", 0, LIMITS.durationMs),
      label: str(m, "label", LIMITS.markerLabel)!,
      note: str(m, "note", LIMITS.note, { optional: true }),
    };
  });

  return {
    label: str(body, "label", LIMITS.label)!,
    started_at,
    ended_at,
    duration_ms: int(s, "duration_ms", 0, LIMITS.durationMs),
    audio_source: str(s, "audio_source", LIMITS.audioSource)!,
    audio_source_kind,
    frames: int(s, "frames"),
    dropped_samples: int(s, "dropped_samples"),
    activity_ms: int(s, "activity_ms", 0, LIMITS.durationMs),
    activity_segments: int(s, "activity_segments"),
    manual_markers: int(s, "manual_markers"),
    median_noise_floor_dbfs: db(s, "median_noise_floor_dbfs"),
    max_rms_dbfs: db(s, "max_rms_dbfs"),
    motion_connected: body.motion_connected === true,
    quality_ms,
    markers,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const isUuid = (v: string) => UUID.test(v);
