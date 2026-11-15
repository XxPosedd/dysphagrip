import { json, request } from "./api";
import { API_BASE } from "./config";

export interface MonitorStatus {
  state: "idle" | "starting" | "recording" | "stopping" | "error";
  error: string | null;
  session: string | null;
  elapsed_seconds: number;
  hardware: { audio: boolean; imu: boolean };
  devices?: { audio: boolean; imu: boolean } | null;
  calibrated: boolean;
  audio_waveform: number[];
  audio_span_seconds?: number;
  audio_end_offset_seconds?: number;
  motion: { time: number[]; accel: number[]; gyro: number[] };
  activity: { label: string; score: number | null; time: number; raw_label: string } | null;
  marks: number;
  last_mark: { id: number; category: string } | null;
  event_count: number;
}

export const markChoices = [
  { category: "swallowing_saliva", name: "Swallowing saliva" },
  { category: "swallowing_water", name: "Swallowing water" },
  { category: "speaking", name: "Speaking" },
  { category: "head_movement", name: "Head movement" },
  { category: "coughing", name: "Coughing" },
  { category: "rest", name: "Rest" },
] as const;

export function activityName(category: string) {
  const text = category.replaceAll("_", " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export interface MonitorHistory {
  storage: "neon" | "local";
  sessions: { session_id: string; started_at: string; duration_seconds: number; marks: number; event_count: number; source?: "neon" | "local" }[];
}

export interface Research {
  studies: {
    id: string; title: string; authors: string; year: number | string; journal: string; url: string;
    doi: string; summary: string; topic: string; provenance: "bright_data_live" | "bright_data_cached" | "curated";
    retrievedAt: string | null;
  }[];
  brightData: { configured: boolean; status: "live" | "cached" | "partial" | "unavailable" | "unconfigured" };
}

export const monitor = {
  status: (signal?: AbortSignal) => request<MonitorStatus>("/api/monitor/status", { signal, cache: "no-store" }),
  command: (action: "start" | "stop" | "mark", category?: string) =>
    request<MonitorStatus>("/api/monitor/" + action, json(category ? { category } : {})),
  history: () => request<MonitorHistory>(API_BASE + "/api/monitor-history", { cache: "no-store" }),
  save: (id: string) => request<unknown>(API_BASE + "/api/monitor-history", json({ session_id: id })),
  research: () => request<Research>(API_BASE + "/api/research"),
};
