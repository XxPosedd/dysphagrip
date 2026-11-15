// Mirrors the audio-service WebSocket contract (services/audio/README.md).

export type QualityLabel = "ok" | "no_signal" | "clipping" | "mains_hum";

export interface AudioFeatures {
  rms_dbfs: number;
  peak: number;
  clip_fraction: number;
  zcr: number;
  spectral_centroid_hz: number;
  dominant_hz: number;
  band_fraction: { low: number; mid: number; high: number };
  hum_ratio: number;
  noise_floor_dbfs: number;
  snr_db: number;
  activity: boolean;
}

export interface AudioFrame {
  type: "audio_frame";
  seq: number;
  source: "device" | "file" | string;
  fs: number;
  sample_index: number;
  n_samples: number;
  t_start_unix_ms: number | null;
  t_end_unix_ms: number | null;
  dropped_samples: number;
  waveform: { min: number[]; max: number[] };
  spectrum: { fmax_hz: number; db: number[] };
  features: AudioFeatures;
  quality: { label: QualityLabel; reasons: string[] };
}

export interface AudioSourceInfo {
  kind: "device" | "file" | string;
  samplerate: number;
  anchor_unix_ms: number | null;
  anchor_method: string | null;
  samples_captured: number;
  wall_minus_sample_clock_ms: number | null;
  device_index?: number;
  device_name?: string;
  hostapi?: string | null;
  channel?: number;
  um2_match?: "strong" | "possible" | null;
  overflows?: number;
  file?: string;
}

export interface AudioStatus {
  running: boolean;
  source: AudioSourceInfo | null;
  dropped_samples: number;
  frames_sent: number;
  clients: number;
  last_error: string | null;
}

export type AudioMessage =
  | AudioFrame
  | ({ type: "hello" | "status" } & AudioStatus)
  | { type: "error"; message: string };

export interface AudioDevice {
  index: number;
  name: string;
  hostapi: string | null;
  max_input_channels: number;
  default_samplerate: number;
  is_default: boolean;
  um2_match: "strong" | "possible" | null;
}

export type MarkerKind = "manual" | "audio_activity" | "quality";

export interface EventMarker {
  id: string;
  kind: MarkerKind;
  /** Session-relative start, ms. */
  t_ms: number;
  /** Duration in ms for segment markers (audio activity, quality episodes). */
  duration_ms?: number;
  label: string;
  note?: string;
}

export interface TimelinePoint {
  t_ms: number;
  rms_dbfs: number;
  noise_floor_dbfs: number;
  activity: boolean;
  /** Raw per-frame quality label. */
  quality: QualityLabel;
  /** Debounced label (changes only after persisting >= 1 s); used for display. */
  stable_quality: QualityLabel;
}

export interface SessionSummary {
  started_at: string;          // ISO 8601 UTC
  ended_at: string | null;
  duration_ms: number;
  audio_source: string;        // human-readable, e.g. "UM2 · ch 1" or "file playback: x.wav"
  audio_source_kind: string;
  frames: number;
  dropped_samples: number;
  quality_ms: Record<QualityLabel, number>;
  activity_ms: number;
  activity_segments: number;
  manual_markers: number;
  median_noise_floor_dbfs: number | null;
  max_rms_dbfs: number | null;
}

/** A session as stored in Neon (GET /api/sessions). */
export interface StoredSession {
  id: string;
  label: string;
  started_at: string;
  ended_at: string;
  duration_ms: number;
  audio_source: string;
  audio_source_kind: string;
  frames: number;
  dropped_samples: number;
  activity_ms: number;
  activity_segments: number;
  manual_markers: number;
  median_noise_floor_dbfs: number | null;
  max_rms_dbfs: number | null;
  motion_connected: boolean;
  created_at: string;
  quality_ms: Record<QualityLabel, number>;
}

export interface StoredMarker {
  kind: MarkerKind | "movement_interference";
  t_ms: number;
  duration_ms: number | null;
  label: string;
  note: string | null;
}

export interface SessionPayload {
  label: string;
  motion_connected: boolean;
  summary: SessionSummary;
  markers: Array<{ kind: MarkerKind; t_ms: number; duration_ms: number | null; label: string; note: string | null }>;
}

export interface ApiHealth {
  ok: boolean;
  integrations: { database: boolean; elevenlabs: boolean; brightdata: boolean };
}
