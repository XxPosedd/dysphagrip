// Endpoints. In development Vite proxies /api -> Express (:3000) and /audio -> Python (:8765).
export const API_BASE = import.meta.env.VITE_API_URL || import.meta.env.BASE_URL.replace(/\/$/, "");

export const AUDIO_HTTP_BASE = "/audio";

export function audioWsUrl(): string {
  if (import.meta.env.VITE_AUDIO_WS_URL) return import.meta.env.VITE_AUDIO_WS_URL;
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/audio/stream`;
}
