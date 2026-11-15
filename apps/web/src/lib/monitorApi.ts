import { AUDIO_HTTP_BASE } from "./config";
import { ApiError } from "./api";
import type { AppMode, CalibrationProgress, ImuStatus, MonitorSessionSummary, SerialPortInfo } from "./monitorTypes";
import type { AudioDevice } from "./types";

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new ApiError("Monitor service unreachable", 0);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = (body as { detail?: unknown }).detail;
    throw new ApiError(typeof detail === "string" ? detail : res.statusText || `HTTP ${res.status}`, res.status);
  }
  return body as T;
}

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export const monitorApi = {
  health: () => request<{
    ok: boolean;
    mode: AppMode;
    monitoring: boolean;
    session_id: string | null;
    audio: { running: boolean; last_error: string | null; source: unknown };
    imu: ImuStatus;
    demo_banner_required: boolean;
  }>(`${AUDIO_HTTP_BASE}/api/health`),

  devices: () => request<{
    mode: AppMode;
    audio: { devices: AudioDevice[]; um2_candidate: number | null; usb_audio_candidate: number | null; running: boolean };
    imu: { status: ImuStatus; serial_ports: SerialPortInfo[] };
  }>(`${AUDIO_HTTP_BASE}/api/devices`),

  setMode: (mode: AppMode) => request(`${AUDIO_HTTP_BASE}/api/mode`, json({ mode })),

  connectImu: (body: { transport: "serial" | "tcp"; port?: string; host?: string; tcp_port?: number; baud?: number }) =>
    request<ImuStatus>(`${AUDIO_HTTP_BASE}/api/imu/connect`, json(body)),

  disconnectImu: () => request<ImuStatus>(`${AUDIO_HTTP_BASE}/api/imu/disconnect`, { method: "POST" }),

  startSession: (label?: string) =>
    request<{ ok: boolean; session_id: string; mode: AppMode }>(`${AUDIO_HTTP_BASE}/api/sessions/start`, json({ label })),

  stopSession: () => request<{ ok: boolean; session_id: string | null; saved: MonitorSessionSummary | null }>(
    `${AUDIO_HTTP_BASE}/api/sessions/stop`, { method: "POST" },
  ),

  resetSession: () => request(`${AUDIO_HTTP_BASE}/api/sessions/reset`, { method: "POST" }),

  startCalibration: () => request<CalibrationProgress>(`${AUDIO_HTTP_BASE}/api/calibration`, { method: "POST" }),

  calibration: () => request<CalibrationProgress>(`${AUDIO_HTTP_BASE}/api/calibration`),

  sessions: () => request<{ sessions: MonitorSessionSummary[] }>(`${AUDIO_HTTP_BASE}/api/sessions`),

  session: (id: string) => request<MonitorSessionSummary>(`${AUDIO_HTTP_BASE}/api/sessions/${encodeURIComponent(id)}`),

  exportUrl: (id: string, format: "json" | "csv" = "json") =>
    `${AUDIO_HTTP_BASE}/api/sessions/${encodeURIComponent(id)}/export?format=${format}`,

  deleteSession: async (id: string) => {
    await request(`${AUDIO_HTTP_BASE}/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
  },
};

export function liveWsUrl(): string {
  if (import.meta.env.VITE_LIVE_WS_URL) return import.meta.env.VITE_LIVE_WS_URL;
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/audio/ws/live`;
}
