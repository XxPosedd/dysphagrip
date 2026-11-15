import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { createApp, redact } from "../app.js";
import { parseSessionInput, ValidationError } from "../validation.js";
import { MemoryStore, validPayload } from "./fixtures.js";

describe("session validation", () => {
  it("accepts a valid payload and normalises it", () => {
    const s = parseSessionInput(validPayload());
    expect(s.label).toBe("Test session · bench check");
    expect(s.quality_ms).toEqual({ ok: 25_000, no_signal: 5_000, clipping: 0, mains_hum: 0 });
    expect(s.markers).toHaveLength(3);
    expect(s.markers[0].note).toBeNull();
    expect(s.markers[1].note).toBe("sip of water");
    expect(s.audio_source_kind).toBe("device");
  });

  const bad: Array<[string, Record<string, unknown>]> = [
    ["missing summary", { summary: undefined }],
    ["empty label", { label: "  " }],
    ["long label", { label: "x".repeat(121) }],
    ["unknown marker kind", { markers: [{ kind: "aspiration", t_ms: 0, label: "x" }] }],
    ["negative marker time", { markers: [{ kind: "manual", t_ms: -5, label: "x" }] }],
    ["long note", { markers: [{ kind: "manual", t_ms: 0, label: "x", note: "n".repeat(281) }] }],
    ["markers not an array", { markers: "nope" }],
    ["NaN duration", { summary: { ...validPayload().summary, duration_ms: Number.NaN } }],
    ["end before start", { summary: { ...validPayload().summary, ended_at: "2026-11-14T14:00:00.000Z" } }],
    ["non-ISO date", { summary: { ...validPayload().summary, started_at: "yesterday" } }],
    ["absurd dBFS", { summary: { ...validPayload().summary, max_rms_dbfs: 999 } }],
  ];
  it.each(bad)("rejects %s", (_name, override) => {
    expect(() => parseSessionInput(validPayload(override))).toThrow(ValidationError);
  });

  it("rejects more than 5000 markers", () => {
    const markers = Array.from({ length: 5001 }, (_, i) => ({ kind: "manual", t_ms: i, label: "m" }));
    expect(() => parseSessionInput(validPayload({ markers }))).toThrow(/5000/);
  });

  it("maps unknown source kinds to 'unknown' rather than rejecting", () => {
    const s = parseSessionInput(validPayload({ summary: { ...validPayload().summary, audio_source_kind: "test" } }));
    expect(s.audio_source_kind).toBe("unknown");
  });
});

describe("session routes (in-memory test store)", () => {
  let store: MemoryStore;
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    store = new MemoryStore();
    app = createApp({ store });
  });

  it("reports the database as configured and reachable", async () => {
    expect((await request(app).get("/api/health")).body.integrations.database).toBe(true);
    const st = await request(app).get("/api/db/status");
    expect(st.status).toBe(200);
    expect(st.body.ok).toBe(true);
  });

  it("creates, lists, reads and deletes a session", async () => {
    const created = await request(app).post("/api/sessions").send(validPayload());
    expect(created.status).toBe(201);
    const id = created.body.session.id;
    expect(created.body.session.markers).toBeUndefined();

    const list = await request(app).get("/api/sessions");
    expect(list.body.sessions.map((s: { id: string }) => s.id)).toEqual([id]);

    const detail = await request(app).get(`/api/sessions/${id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.session.markers).toHaveLength(3);
    expect(detail.body.session.quality_ms.no_signal).toBe(5_000);

    expect((await request(app).delete(`/api/sessions/${id}`)).status).toBe(204);
    expect((await request(app).get(`/api/sessions/${id}`)).status).toBe(404);
    expect((await request(app).delete(`/api/sessions/${id}`)).status).toBe(404);
  });

  it("returns 400 with a reason for invalid payloads and ids", async () => {
    const res = await request(app).post("/api/sessions").send(validPayload({ label: "" }));
    expect(res.status).toBe(400);
    expect(res.body.detail).toMatch(/label/);
    expect((await request(app).get("/api/sessions/not-a-uuid")).status).toBe(400);
    expect(store.sessions.size).toBe(0);
  });

  it("caps the list limit", async () => {
    for (let i = 0; i < 3; i++) await request(app).post("/api/sessions").send(validPayload());
    expect((await request(app).get("/api/sessions?limit=2")).body.sessions).toHaveLength(2);
    expect((await request(app).get("/api/sessions?limit=-4")).body.sessions).toHaveLength(1);
  });

  it("returns 502 with a redacted message when the database fails", async () => {
    store.failNext = new Error("connect failed for postgresql://user:secret@ep-x.neon.tech/db");
    const res = await request(app).post("/api/sessions").send(validPayload());
    expect(res.status).toBe(502);
    expect(res.body.detail).not.toContain("secret");
    expect(res.body.detail).toContain("[redacted]");
  });
});

describe("redact", () => {
  it("removes connection strings", () => {
    expect(redact("bad postgres://a:b@h/db?sslmode=require here")).toBe("bad postgres://[redacted] here");
  });
});

describe("read-only public demo mode", () => {
  it("blocks session writes and deletes but still serves reads", async () => {
    const store = new MemoryStore();
    const seeded = await store.create(parseSessionInput(validPayload()));
    const app = createApp({ store, readOnly: true });
    expect((await request(app).get("/api/health")).body.read_only).toBe(true);
    const post = await request(app).post("/api/sessions").send(validPayload());
    expect(post.status).toBe(403);
    expect(post.body.error).toMatch(/read-only/);
    expect((await request(app).delete(`/api/sessions/${seeded.id}`)).status).toBe(403);
    expect(store.sessions.size).toBe(1);
    expect((await request(app).get("/api/sessions")).body.sessions).toHaveLength(1);
    expect((await request(app).get(`/api/sessions/${seeded.id}`)).status).toBe(200);
  });

  it("is off unless DEMO_READ_ONLY=true", async () => {
    delete process.env.DEMO_READ_ONLY;
    expect((await request(createApp({ store: new MemoryStore() })).get("/api/health")).body.read_only).toBe(false);
    process.env.DEMO_READ_ONLY = "true";
    try {
      expect((await request(createApp({ store: new MemoryStore() })).post("/api/sessions").send(validPayload())).status).toBe(403);
    } finally {
      delete process.env.DEMO_READ_ONLY;
    }
  });
});
