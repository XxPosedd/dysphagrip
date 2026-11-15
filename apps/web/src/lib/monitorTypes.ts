import type { AudioFrame, QualityLabel } from "./types";

export type AppMode = "live" | "demo";

export type DeviceState = "disconnected" | "connecting" | "connected" | "stale" | "error" | "idle" | "open";

export interface ImuSampleMsg {
  type?: string;
  seq: number;
  board_t_ms?: number | null;
  host_unix_ms: number;
  ax: number;
  ay: number;
  az: number;
  gx: number;
  gy: number;
  gz: number;
  accel_mag: number;
  gyro_mag: number;
  demo?: boolean;
}

export interface ImuFeatures {
  accel_mag: number;
  gyro_mag: number;
  motion_energy: number;
  movement_variability: number;
  above_baseline: boolean;
}

export interface ImuStatus {
  state: DeviceState | string;
  transport: string | null;
  endpoint: string | null;
  last_error: string | null;
  samples_received: number;
  last_host_unix_ms?: number | null;
  freshness_ms?: number | null;
  sensor_ok?: boolean | null;
}

export type EventCategory =
  | "swallow_candidate"
  | "motion_artifact"
  | "unclassified_activity"
  | "baseline_idle";

export interface CandidateEvent {
  type?: "candidate_event";
  id: string;
  category: EventCategory | string;
  t_unix_ms: number;
  session_t_ms: number;
  duration_ms: number;
  heuristic_score: number;
  reason: string;
  features: Record<string, unknown>;
  algorithm_version: string;
  disclaimer?: string;
}

export interface SessionSnapshot {
  type?: string;
  mode: AppMode;
  monitoring: boolean;
  session_id: string | null;
  elapsed_ms: number;
  metrics: {
    swallow_candidates: number;
    motion_artifacts: number;
    unclassified: number;
    frames: number;
  };
  events_count: number;
  calibration?: CalibrationProgress;
  demo?: boolean;
}

export interface CalibrationProgress {
  running: boolean;
  progress: number;
  elapsed_ms: number;
  target_ms: number;
  latest_rms_dbfs: number | null;
  latest_motion_energy: number | null;
  result?: CalibrationResult | null;
}

export interface CalibrationResult {
  completed: boolean;
  mode: string;
  message: string;
  error?: string | null;
  baseline_rms_dbfs?: number | null;
  baseline_noise_floor_dbfs?: number | null;
  baseline_accel_mag?: number | null;
  baseline_motion_energy?: number | null;
  suggested_activity_db?: number | null;
  suggested_motion_artifact?: number | null;
  disclaimer?: string;
}

export interface LiveFrameMessage {
  type: "live_frame";
  mode: AppMode;
  demo: boolean;
  audio: AudioFrame;
  imu: ImuSampleMsg | null;
  imu_features: ImuFeatures | null;
  event: CandidateEvent | null;
  activity_state: string;
  device_health: {
    audio_running: boolean;
    audio_source?: string;
    imu: ImuStatus;
  };
  session: SessionSnapshot;
}

export interface MonitorSessionSummary {
  id: string;
  label: string;
  mode: string;
  started_at_unix_ms: number;
  ended_at_unix_ms: number | null;
  duration_ms: number;
  swallow_candidates: number;
  motion_artifacts: number;
  unclassified: number;
  audio_source: string | null;
  imu_transport: string | null;
  signal_quality_summary: string | null;
  created_at_unix_ms: number;
  events?: CandidateEvent[];
  metrics?: Record<string, unknown>;
  calibration?: CalibrationResult | null;
}

export interface SerialPortInfo {
  device: string;
  description: string;
  hwid: string;
  manufacturer: string;
}

export type QualityTone = QualityLabel;
