import type { AudioFrame, AudioMessage, AudioStatus } from "./types";

/** Validate an incoming WebSocket payload. Returns null for anything malformed. */
export function parseAudioMessage(raw: string): AudioMessage | null {
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!m || typeof m !== "object") return null;
  const msg = m as Record<string, unknown>;
  switch (msg.type) {
    case "audio_frame": {
      const wf = msg.waveform as AudioFrame["waveform"] | undefined;
      const sp = msg.spectrum as AudioFrame["spectrum"] | undefined;
      const f = msg.features as AudioFrame["features"] | undefined;
      const q = msg.quality as AudioFrame["quality"] | undefined;
      if (!wf || !Array.isArray(wf.min) || !Array.isArray(wf.max)) return null;
      if (!sp || !Array.isArray(sp.db) || typeof sp.fmax_hz !== "number") return null;
      if (!f || typeof f.rms_dbfs !== "number" || !q || typeof q.label !== "string") return null;
      return msg as unknown as AudioFrame;
    }
    case "hello":
    case "status":
      return typeof msg.running === "boolean" ? (msg as unknown as AudioMessage) : null;
    case "error":
      return typeof msg.message === "string" ? (msg as unknown as AudioMessage) : null;
    default:
      return null;
  }
}

export type ConnectionState = "connecting" | "open" | "closed";

export interface StreamHandlers {
  onFrame: (f: AudioFrame) => void;
  onStatus: (s: AudioStatus) => void;
  onError: (message: string) => void;
  onConnection: (state: ConnectionState) => void;
}

/** WebSocket client with automatic reconnect (back-off capped at 5 s). */
export class AudioStream {
  private ws: WebSocket | null = null;
  private retry = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(private url: string, private h: StreamHandlers) {}

  connect(): void {
    this.closed = false;
    this.h.onConnection("connecting");
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.h.onConnection("open");
    };
    ws.onmessage = (ev) => {
      const m = parseAudioMessage(String(ev.data));
      if (!m) return;
      if (m.type === "audio_frame") this.h.onFrame(m);
      else if (m.type === "error") this.h.onError(m.message);
      else this.h.onStatus(m);
    };
    ws.onclose = () => {
      this.h.onConnection("closed");
      if (this.closed) return;
      const delay = Math.min(5000, 500 * 2 ** this.retry++);
      this.timer = setTimeout(() => this.connect(), delay);
    };
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.ws?.close();
    this.ws = null;
  }
}
