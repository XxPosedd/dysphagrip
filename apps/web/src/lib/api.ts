import { API_BASE, AUDIO_HTTP_BASE } from "./config";
import type { ApiHealth, AudioDevice, AudioStatus, PublicResource, SessionPayload, StoredMarker, StoredSession } from "./types";

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new ApiError("Service unreachable", 0);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = (body as { detail?: unknown; error?: unknown }).detail ?? (body as { error?: unknown }).error;
    if (typeof detail === "string") throw new ApiError(detail, res.status);
    // No JSON body: in development this is the Vite proxy reporting that the target server is down.
    if (res.status >= 500) throw new ApiError(`API server unreachable (HTTP ${res.status}). Is it running?`, res.status);
    throw new ApiError(res.statusText || `HTTP ${res.status}`, res.status);
  }
  return body as T;
}

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

// ---- Python audio service ----
export const audioApi = {
  devices: () => request<{ devices: AudioDevice[]; um2_candidate: number | null }>(`${AUDIO_HTTP_BASE}/devices`),
  status: () => request<AudioStatus>(`${AUDIO_HTTP_BASE}/status`),
  start: (device: number | null, channel: number) =>
    request<AudioStatus>(`${AUDIO_HTTP_BASE}/start`, json({ device, channel })),
  stop: () => request<AudioStatus>(`${AUDIO_HTTP_BASE}/stop`, { method: "POST" }),
};

// ---- Express API ----
export const api = {
  health: () => request<ApiHealth>(`${API_BASE}/api/health`),
  resources: () => request<{ configured: boolean; resources: PublicResource[]; note?: string }>(`${API_BASE}/api/resources`),
  dbStatus: () => request<{ ok: boolean; latency_ms: number }>(`${API_BASE}/api/db/status`),
  sessions: () => request<{ sessions: StoredSession[] }>(`${API_BASE}/api/sessions`),
  session: (id: string) => request<{ session: StoredSession & { markers: StoredMarker[] } }>(`${API_BASE}/api/sessions/${encodeURIComponent(id)}`),
  saveSession: (payload: SessionPayload) => request<{ session: StoredSession }>(`${API_BASE}/api/sessions`, json(payload)),
  async deleteSession(id: string): Promise<void> {
    let res: Response;
    try {
      res = await fetch(`${API_BASE}/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
    } catch {
      throw new ApiError("API unreachable", 0);
    }
    if (!res.ok && res.status !== 404) {
      const body = await res.json().catch(() => ({}));
      throw new ApiError((body as { error?: string }).error || `HTTP ${res.status}`, res.status);
    }
  },
  voice: () => request<{ configured: boolean; model_id: string | null; voice: { id: string; name: string | null } | null }>(`${API_BASE}/api/voice`),
  /** Returns an audio Blob, or throws ApiError(501) when ElevenLabs is not configured. */
  async speak(message: string): Promise<Blob> {
    let res: Response;
    try {
      res = await fetch(`${API_BASE}/api/voice/status`, json({ message }));
    } catch {
      throw new ApiError("API unreachable", 0);
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new ApiError((body as { error?: string }).error || `HTTP ${res.status}`, res.status);
    }
    return res.blob();
  },
};
