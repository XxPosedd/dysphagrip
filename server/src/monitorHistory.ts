import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import path from "node:path";
import { Router } from "express";
import { neon } from "@neondatabase/serverless";

export interface MonitorSummary {
  session_id: string;
  started_at: string;
  duration_seconds: number;
  marks: number;
  event_count: number;
}
export interface MonitorHistoryStore {
  upsert(rows: MonitorSummary[]): Promise<void>;
  list(): Promise<MonitorSummary[]>;
}

export class NeonMonitorHistory implements MonitorHistoryStore {
  private readonly sql: ReturnType<typeof neon>;
  private ready?: Promise<unknown>;

  constructor(connection: string) { this.sql = neon(connection); }

  private query(statement: string, values: unknown[] = []) {
    return this.sql.query(statement, values, { fetchOptions: { signal: AbortSignal.timeout(5000) } });
  }

  private ensureTable() {
    this.ready ??= this.query(`CREATE TABLE IF NOT EXISTS monitor_recording_history (
      session_id text PRIMARY KEY, started_at timestamptz NOT NULL,
      duration_seconds double precision NOT NULL CHECK (duration_seconds >= 0),
      marks integer NOT NULL CHECK (marks >= 0), event_count integer NOT NULL CHECK (event_count >= 0)
    )`).catch(error => { this.ready = undefined; throw error; });
    return this.ready;
  }

  async upsert(rows: MonitorSummary[]) {
    if (!rows.length) return;
    await this.ensureTable();
    await this.query(`INSERT INTO monitor_recording_history (session_id, started_at, duration_seconds, marks, event_count)
      SELECT * FROM unnest($1::text[], $2::timestamptz[], $3::double precision[], $4::int[], $5::int[])
      ON CONFLICT (session_id) DO UPDATE SET started_at = excluded.started_at, duration_seconds = excluded.duration_seconds,
          marks = excluded.marks, event_count = excluded.event_count`, [
      rows.map(r => r.session_id), rows.map(r => r.started_at), rows.map(r => r.duration_seconds),
      rows.map(r => r.marks), rows.map(r => r.event_count),
    ]);
  }

  async list() {
    await this.ensureTable();
    const rows = await this.query(`SELECT session_id, started_at, duration_seconds, marks, event_count
                                FROM monitor_recording_history ORDER BY started_at DESC`) as Record<string, unknown>[];
    return rows.map(r => ({ session_id: String(r.session_id), started_at: new Date(String(r.started_at)).toISOString(),
      duration_seconds: Number(r.duration_seconds), marks: Number(r.marks), event_count: Number(r.event_count) }));
  }
}

const validId = (id: unknown): id is string => typeof id === "string" && /^\d{8}_\d{6}_[a-zA-Z0-9_-]{1,64}$/.test(id);
const time = (value: unknown): value is string => typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value));
const amount = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
const count = (n: unknown): n is number => amount(n) && Number.isInteger(n) && n <= 2_147_483_647;
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

async function readSmallFile(folder: string, name: string) {
  try {
    const handle = await open(path.join(folder, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 64_000) throw new Error("Invalid recording metadata file");
      return await handle.readFile("utf8");
    } finally { await handle.close(); }
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}

function summary(id: string, row: Record<string, unknown>): MonitorSummary | null {
  if (!time(row.started_at) || !amount(row.duration_seconds) || !count(row.marks) || !count(row.event_count)) return null;
  return { session_id: id, started_at: new Date(row.started_at).toISOString(),
    duration_seconds: row.duration_seconds, marks: row.marks, event_count: row.event_count };
}

async function readLocal(root: string, id: string, includeLegacy: boolean) {
  if (!validId(id)) return null;
  const folder = path.join(root, id);
  try {
    if (!(await lstat(folder)).isDirectory()) return null;
    const web = await readSmallFile(folder, "web_recording.json");
    if (web !== null) {
      const row = JSON.parse(web);
      if (row?.session_id !== id || !time(row.completed_at)) return null;
      const data = summary(id, row);
      return data && { data, web: true };
    }
    if (!includeLegacy || await readSmallFile(folder, "web_recording.pending") !== null) return null;
    const csv = await readSmallFile(folder, "summary.csv");
    if (!csv) return null;
    // Python's summary writer emits unquoted ISO/numeric fields preceding the textual disclaimer.
    const [header, first] = csv.trim().split(/\r?\n/);
    if (!first) return null;
    const columns = header.split(",");
    const values = first.split(",");
    const field = (name: string) => values[columns.indexOf(name)]?.trim();
    const number = (name: string) => field(name) ? Number(field(name)) : NaN;
    const data = summary(id, { started_at: field("started_at"), duration_seconds: number("duration_seconds"),
      marks: number("label_count"), event_count: number("prediction_count") });
    return data && { data, web: false };
  } catch (error) {
    if (missing(error) || error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ELOOP") return null;
    throw error;
  }
}

function sameSummary(a: MonitorSummary | undefined, b: MonitorSummary) {
  return a?.started_at === b.started_at && a.duration_seconds === b.duration_seconds &&
    a.marks === b.marks && a.event_count === b.event_count;
}

export function monitorHistoryRouter(directory: string, store: MonitorHistoryStore | null) {
  const router = Router();
  router.get("/", async (_req, res) => {
    const local: { data: MonitorSummary; web: boolean }[] = [];
    let localReadable = true;
    try {
      const entries = await readdir(directory, { withFileTypes: true }).catch(error => {
        if (missing(error)) return [];
        throw error;
      });
      // Handle each directory independently so a damaged legacy summary cannot hide healthy recordings.
      for (const entry of entries) {
        if (!entry.isDirectory() || !validId(entry.name)) continue;
        const item = await readLocal(directory, entry.name, true).catch(() => null);
        if (item) local.push(item);
      }
    } catch {
      localReadable = false;
    }
    const rows = new Map(local.map(({ data }) => [data.session_id, { ...data, source: "local" }]));
    let storage = "local";
    if (store) {
      try {
        const remote = new Map((await store.list()).map(row => [row.session_id, row]));
        const pending = local.filter(r => r.web && !sameSummary(remote.get(r.data.session_id), r.data)).map(r => r.data);
        if (pending.length) await store.upsert(pending);
        for (const record of [...remote.values(), ...pending]) rows.set(record.session_id, { ...record, source: "neon" });
        storage = "neon";
      } catch { /* The next request retries; recording files remain the source for unsynced sessions. */ }
    }
    if (!localReadable && storage === "local") return void res.status(503).json({ error: "Recording history unavailable" });
    const sessions = [...rows.values()].sort((a, b) => b.started_at.localeCompare(a.started_at) || b.session_id.localeCompare(a.session_id));
    res.json({ sessions, storage });
  });
  router.post("/", async (req, res) => {
    const id = req.body?.session_id;
    if (!validId(id)) return void res.status(400).json({ error: "Invalid session ID" });
    try {
      const item = await readLocal(directory, id, false);
      if (!item) return void res.status(404).json({ error: "Completed web recording not found" });
      let storage = "local";
      if (store) {
        try { await store.upsert([item.data]); storage = "neon"; } catch { /* Retry on history refresh. */ }
      }
      res.json({ session: { ...item.data, source: storage }, storage });
    } catch { res.status(503).json({ error: "Recording metadata unavailable" }); }
  });
  return router;
}
