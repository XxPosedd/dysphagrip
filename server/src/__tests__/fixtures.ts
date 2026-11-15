import { randomUUID } from "node:crypto";
import type { SessionDetail, SessionStore, StoredSession } from "../db.js";
import type { SessionInput } from "../validation.js";

export function validPayload(overrides: Record<string, unknown> = {}) {
  return {
    label: "Test session · bench check",
    motion_connected: false,
    summary: {
      started_at: "2026-11-14T15:00:00.000Z",
      ended_at: "2026-11-14T15:00:30.000Z",
      duration_ms: 30_000,
      audio_source: "Behringer UM2 · ch 1",
      audio_source_kind: "device",
      frames: 600,
      dropped_samples: 0,
      quality_ms: { ok: 25_000, no_signal: 5_000, clipping: 0, mains_hum: 0 },
      activity_ms: 2_400,
      activity_segments: 3,
      manual_markers: 1,
      median_noise_floor_dbfs: -72.5,
      max_rms_dbfs: -18.2,
    },
    markers: [
      { kind: "audio_activity", t_ms: 1_000, duration_ms: 800, label: "Audio activity (experimental)" },
      { kind: "manual", t_ms: 4_000, label: "Manual marker", note: "sip of water" },
      { kind: "quality", t_ms: 20_000, duration_ms: 5_000, label: "No signal" },
    ],
    ...overrides,
  };
}

/** In-memory SessionStore TEST DOUBLE. Only used by tests; never wired into the running app. */
export class MemoryStore implements SessionStore {
  sessions = new Map<string, SessionDetail>();
  failNext: Error | null = null;

  private check() {
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      throw e;
    }
  }

  async create(input: SessionInput): Promise<StoredSession> {
    this.check();
    const { markers, ...rest } = input;
    const s: SessionDetail = { ...rest, id: randomUUID(), created_at: new Date().toISOString(), markers };
    this.sessions.set(s.id, s);
    const { markers: _m, ...session } = s;
    return session;
  }
  async list(limit: number) {
    this.check();
    return [...this.sessions.values()].sort((a, b) => b.started_at.localeCompare(a.started_at)).slice(0, limit)
      .map(({ markers: _m, ...s }) => s);
  }
  async get(id: string) {
    this.check();
    return this.sessions.get(id) ?? null;
  }
  async remove(id: string) {
    this.check();
    return this.sessions.delete(id);
  }
  async ping() {
    this.check();
  }
}
