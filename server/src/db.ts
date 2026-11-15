import { randomUUID } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import { QUALITY_LABELS, type MarkerKind, type QualityLabel, type SessionInput } from "./validation.js";

export interface StoredMarker {
  kind: MarkerKind;
  t_ms: number;
  duration_ms: number | null;
  label: string;
  note: string | null;
}

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

export interface SessionDetail extends StoredSession {
  markers: StoredMarker[];
}

/** Persistence boundary. The API depends on this interface, so routes are testable without a database. */
export interface SessionStore {
  create(input: SessionInput): Promise<StoredSession>;
  list(limit: number): Promise<StoredSession[]>;
  get(id: string): Promise<SessionDetail | null>;
  remove(id: string): Promise<boolean>;
  ping(): Promise<void>;
}

const toIso = (v: unknown) => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

function emptyQuality(): Record<QualityLabel, number> {
  return Object.fromEntries(QUALITY_LABELS.map((q) => [q, 0])) as Record<QualityLabel, number>;
}

function rowToSession(r: Record<string, unknown>): StoredSession {
  const quality = emptyQuality();
  const q = r.quality as Record<string, unknown> | null;
  if (q) for (const k of QUALITY_LABELS) if (q[k] !== undefined) quality[k] = Number(q[k]);
  return {
    id: String(r.id),
    label: String(r.label),
    started_at: toIso(r.started_at),
    ended_at: toIso(r.ended_at),
    duration_ms: Number(r.duration_ms),
    audio_source: String(r.audio_source),
    audio_source_kind: String(r.audio_source_kind),
    frames: Number(r.frames),
    dropped_samples: Number(r.dropped_samples),
    activity_ms: Number(r.activity_ms),
    activity_segments: Number(r.activity_segments),
    manual_markers: Number(r.manual_markers),
    median_noise_floor_dbfs: num(r.median_noise_floor_dbfs),
    max_rms_dbfs: num(r.max_rms_dbfs),
    motion_connected: Boolean(r.motion_connected),
    created_at: toIso(r.created_at),
    quality_ms: quality,
  };
}

const SESSION_SELECT = `
  SELECT s.*,
         COALESCE((SELECT json_object_agg(q.quality, q.duration_ms) FROM session_quality q WHERE q.session_id = s.id),
                  '{}'::json) AS quality
  FROM recording_sessions s`;

export class NeonSessionStore implements SessionStore {
  private sql: ReturnType<typeof neon>;

  constructor(url: string) {
    this.sql = neon(url);
  }

  async create(input: SessionInput): Promise<StoredSession> {
    const id = randomUUID();
    const sql = this.sql;
    const m = input.markers;
    const qualities = QUALITY_LABELS.filter((q) => input.quality_ms[q] > 0);

    // One atomic transaction: session row, markers (bulk via unnest) and quality summary rows.
    await sql.transaction([
      sql`INSERT INTO recording_sessions
            (id, label, started_at, ended_at, duration_ms, audio_source, audio_source_kind, frames, dropped_samples,
             activity_ms, activity_segments, manual_markers, median_noise_floor_dbfs, max_rms_dbfs, motion_connected)
          VALUES (${id}, ${input.label}, ${input.started_at}, ${input.ended_at}, ${input.duration_ms},
             ${input.audio_source}, ${input.audio_source_kind}, ${input.frames}, ${input.dropped_samples},
             ${input.activity_ms}, ${input.activity_segments}, ${input.manual_markers},
             ${input.median_noise_floor_dbfs}, ${input.max_rms_dbfs}, ${input.motion_connected})`,
      sql`INSERT INTO session_markers (session_id, kind, t_ms, duration_ms, label, note)
          SELECT ${id}::uuid, k, t, d, l, n
          FROM unnest(${m.map((x) => x.kind)}::text[], ${m.map((x) => x.t_ms)}::int[],
                      ${m.map((x) => x.duration_ms)}::int[], ${m.map((x) => x.label)}::text[],
                      ${m.map((x) => x.note)}::text[]) AS u(k, t, d, l, n)`,
      sql`INSERT INTO session_quality (session_id, quality, duration_ms)
          SELECT ${id}::uuid, q, d
          FROM unnest(${qualities}::text[], ${qualities.map((q) => input.quality_ms[q])}::int[]) AS u(q, d)`,
    ]);

    const created = await this.get(id);
    if (!created) throw new Error("Session was written but could not be read back");
    const { markers: _markers, ...session } = created;
    return session;
  }

  async list(limit: number): Promise<StoredSession[]> {
    const rows = await this.sql.query(`${SESSION_SELECT} ORDER BY s.started_at DESC LIMIT $1`, [limit]);
    return (rows as Record<string, unknown>[]).map(rowToSession);
  }

  async get(id: string): Promise<SessionDetail | null> {
    const [rows, markers] = await this.sql.transaction([
      this.sql.query(`${SESSION_SELECT} WHERE s.id = $1`, [id]),
      this.sql.query(`SELECT kind, t_ms, duration_ms, label, note FROM session_markers WHERE session_id = $1 ORDER BY t_ms, id`, [id]),
    ], { readOnly: true });
    const row = (rows as Record<string, unknown>[])[0];
    if (!row) return null;
    return {
      ...rowToSession(row),
      markers: (markers as Record<string, unknown>[]).map((r) => ({
        kind: r.kind as MarkerKind,
        t_ms: Number(r.t_ms),
        duration_ms: num(r.duration_ms),
        label: String(r.label),
        note: r.note === null ? null : String(r.note),
      })),
    };
  }

  async remove(id: string): Promise<boolean> {
    const rows = await this.sql`DELETE FROM recording_sessions WHERE id = ${id} RETURNING id`;
    return (rows as unknown[]).length > 0;
  }

  async ping(): Promise<void> {
    await this.sql`SELECT 1`;
  }
}

/** Returns a Neon-backed store when DATABASE_URL is set, otherwise null ("not configured"). */
export function storeFromEnv(): SessionStore | null {
  const url = process.env.DATABASE_URL;
  return url ? new NeonSessionStore(url) : null;
}
