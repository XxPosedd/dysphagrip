import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import type { MonitorHistoryStore, MonitorSummary } from "../monitorHistory.js";

const oldId = "20261115_013515_3id7enan";
const webId = "20261115_110000_web_01";
const t = "2026-11-15T11:00:00.000-08:00";
const web = { session_id: webId, started_at: t, completed_at: "2026-11-15T11:00:05.000-08:00",
  duration_seconds: 4.93, marks: 0, event_count: 2, counts: {}, audio_samples: [123] };
const csv = "started_at,tolerance_seconds,duration_seconds,prediction_count,label_count,disclaimer\r\n" +
  '2026-11-15T01:35:15.844-08:00,1.5,70.075948,3,14,"Manual labels, early trial"\r\n';
let root: string;
async function file(id: string, filename: string, content: string) {
  const dir = path.join(root, id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, filename), content);
}
const api = (store: MonitorHistoryStore | null = null) =>
  request(createApp({ store: null, resources: null, monitorHistoryStore: store, researchBrightData: null }));

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "dysphagrip-history-"));
  vi.stubEnv("DYSPHAGRIP_EXPERIMENTS_DIR", root);
  vi.stubEnv("DYSPHAGRIP_LOCAL_DASHBOARD", "1");
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

describe("local monitor history", () => {
  it("is absent outside local dashboard mode", async () => {
    vi.stubEnv("DYSPHAGRIP_LOCAL_DASHBOARD", "0");
    await api().get("/api/monitor-history").expect(404);
    await api().post("/api/monitor-history").send({ session_id: webId }).expect(404);
  });
  it("reads legacy numbers, excludes unfinished web sessions and avoids raw data", async () => {
    await file(oldId, "summary.csv", csv);
    await file(webId, "summary.csv", csv);
    await file(webId, "web_recording.pending", "");
    const first = await api().get("/api/monitor-history").expect(200);
    expect(first.body).toEqual({ storage: "local", sessions: [{ session_id: oldId,
      started_at: "2026-11-15T09:35:15.844Z", duration_seconds: 70.075948, marks: 14, event_count: 3, source: "local" }] });
    await api().post("/api/monitor-history").send({ session_id: webId }).expect(404);
    await file(webId, "web_recording.json", JSON.stringify(web));
    const saved = await api().post("/api/monitor-history").send({ session_id: webId, event_count: 999 }).expect(200);
    expect(saved.body.session).toMatchObject({ source: "local", duration_seconds: 4.93, event_count: 2, marks: 0 });
    expect(Object.keys(saved.body.session).sort()).toEqual(["session_id", "started_at", "duration_seconds", "event_count", "marks", "source"].sort());
  });
  it("resynchronizes completed sessions after an outage without syncing legacy summaries", async () => {
    await file(oldId, "summary.csv", csv);
    await file(webId, "web_recording.json", JSON.stringify(web));
    const remote = new Map<string, MonitorSummary>();
    const store = { upsert: vi.fn(async (rows: MonitorSummary[]) => { rows.forEach(r => remote.set(r.session_id, r)); }),
      list: vi.fn(async () => [...remote.values()]) };
    store.upsert.mockRejectedValueOnce(new Error("offline"));
    const client = api(store);
    const fallback = await client.post("/api/monitor-history").send({ session_id: webId }).expect(200);
    expect(fallback.body.storage).toBe("local");
    const first = await client.get("/api/monitor-history").expect(200);
    expect(first.body.storage).toBe("neon");
    expect(first.body.sessions.map((s: { source: string }) => s.source)).toEqual(["neon", "local"]);
    await client.get("/api/monitor-history").expect(200);
    expect(store.upsert).toHaveBeenCalledTimes(2);
    expect([...remote.keys()]).toEqual([webId]);
    await rm(path.join(root, webId), { recursive: true });
    const later = await client.get("/api/monitor-history").expect(200);
    expect(later.body.sessions[0].session_id).toBe(webId);
  });
  it("rejects invalid IDs, incomplete metadata, legacy POST and symlinks", async () => {
    await file(oldId, "summary.csv", csv);
    await api().post("/api/monitor-history").send({ session_id: "../" + oldId }).expect(400);
    await api().post("/api/monitor-history").send({ session_id: oldId }).expect(404);
    await file(webId, "web_recording.json", JSON.stringify({ ...web, marks: null }));
    await api().post("/api/monitor-history").send({ session_id: webId }).expect(404);
    await rm(path.join(root, webId, "web_recording.json"));
    await symlink(path.join(root, oldId, "summary.csv"), path.join(root, webId, "web_recording.json"));
    await api().post("/api/monitor-history").send({ session_id: webId }).expect(404);
  });
});
