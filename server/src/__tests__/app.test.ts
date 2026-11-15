import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";

describe("DysphaGrip API (no integrations configured)", () => {
  beforeEach(() => {
    delete process.env.DATABASE_URL;
    delete process.env.ELEVENLABS_API_KEY;
    delete process.env.ELEVENLABS_VOICE_ID;
    delete process.env.BRIGHTDATA_API_TOKEN;
    delete process.env.BRIGHTDATA_DATASET_ID;
  });

  it("reports health and that integrations are not configured", async () => {
    const res = await request(createApp()).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.integrations).toEqual({ database: false, elevenlabs: false, brightdata: false });
  });

  it("returns 503 for every session route when Neon is not configured", async () => {
    const app = createApp();
    for (const [method, url] of [["get", "/api/sessions"], ["post", "/api/sessions"], ["get", "/api/db/status"],
      ["get", "/api/sessions/00000000-0000-4000-8000-000000000000"]] as const) {
      const res = await request(app)[method](url).send({});
      expect(res.status, `${method} ${url}`).toBe(503);
      expect(res.body.detail).toMatch(/DATABASE_URL/);
    }
  });

  it("returns 501 for voice when ElevenLabs is not configured", async () => {
    const res = await request(createApp()).post("/api/voice/status").send({ message: "Recording started." });
    expect(res.status).toBe(501);
  });

  it("rejects empty voice messages", async () => {
    const res = await request(createApp()).post("/api/voice/status").send({});
    expect(res.status).toBe(400);
  });

  it("does not fabricate public resources", async () => {
    const res = await request(createApp()).get("/api/resources");
    expect(res.status).toBe(200);
    expect(res.body.resources).toEqual([]);
  });

  it("answers malformed JSON and unknown API routes with JSON errors", async () => {
    const bad = await request(createApp()).post("/api/voice/status").set("Content-Type", "application/json").send("{oops");
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/Malformed/);
    const missing = await request(createApp()).get("/api/nope");
    expect(missing.status).toBe(404);
  });
});
