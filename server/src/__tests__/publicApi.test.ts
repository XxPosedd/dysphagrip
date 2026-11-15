import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";

describe("public dashboard", () => {
  let voiceDir: string;
  const create = () => createApp({ researchBrightData: null, conditionBrightData: null });
  beforeEach(() => {
    voiceDir = mkdtempSync(path.join(tmpdir(), "dysphagrip-public-"));
    vi.stubEnv("DYSPHAGRIP_PUBLIC", "1");
    vi.stubEnv("DYSPHAGRIP_PUBLIC_VOICE_DIR", voiceDir);
    vi.stubEnv("DYSPHAGRIP_LOCAL_DASHBOARD", "1");
    vi.stubEnv("DATABASE_URL", "invalid-connection-would-throw-if-initialized");
    vi.stubEnv("ELEVENLABS_API_KEY", "unused");
    vi.stubEnv("ELEVENLABS_VOICE_ID", "unused");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(voiceDir, { recursive: true, force: true });
  });

  it("serves public information and omits private, legacy and sensor APIs even with workstation settings", async () => {
    const app = create();
    const health = await request(app).get("/api/health").expect(200);
    expect(health.body).toMatchObject({ local_dashboard: false, public_dashboard: true, integrations: { database: false, elevenlabs: false } });
    expect((await request(app).get("/api/research").expect(200)).body.studies).toHaveLength(3);
    expect((await request(app).get("/api/condition").expect(200)).body.description).toContain("Dysphagia");
    for (const endpoint of ["/api/db/status", "/api/sessions", "/api/sessions/id", "/api/monitor-history",
      "/api/monitor/status", "/api/resources", "/audio/status"]) {
      await request(app).get(endpoint).expect(404);
    }
    for (const endpoint of ["/api/sessions", "/api/monitor/start", "/api/monitor/stop", "/api/monitor-history", "/audio/start"]) {
      await request(app).post(endpoint).send({}).expect(404);
    }
    await request(app).delete("/api/sessions/id").expect(404);
  });

  it("serves both actual bundled audio files when the ElevenLabs pair is absent or incomplete", async () => {
    writeFileSync(path.join(voiceDir, "started.mp3"), Buffer.alloc(256));
    const app = create();
    const voice = await request(app).get("/api/voice").expect(200);
    expect(voice.body).toMatchObject({ configured: false, provider: "macos", fallback_provider: "macos" });
    for (const message of ["Recording started.", "Recording stopped."]) {
      const audio = await request(app).post("/api/voice/status").send({ message }).expect(200);
      expect(audio.headers["x-voice-provider"]).toBe("macos");
      expect(audio.headers["content-type"]).toContain("audio/mp4");
      expect(Number(audio.headers["content-length"])).toBeGreaterThan(100);
    }
    await request(app).post("/api/voice/status").send({ message: "Audio signal detected." }).expect(400);
  });

  it("serves mounted ElevenLabs clips while keeping synthesis unavailable", async () => {
    const mp3 = Buffer.alloc(256);
    mp3.write("ID3");
    for (const name of ["started.mp3", "stopped.mp3"]) writeFileSync(path.join(voiceDir, name), mp3);
    const app = create();
    const voice = await request(app).get("/api/voice").expect(200);
    expect(voice.body).toMatchObject({ configured: true, provider: "elevenlabs", mode: "prerecorded" });
    const audio = await request(app).post("/api/voice/status").send({ message: "Recording started." }).expect(200);
    expect(audio.headers["x-voice-provider"]).toBe("elevenlabs");
    expect(audio.headers["content-type"]).toContain("audio/mpeg");
    expect(Number(audio.headers["content-length"])).toBe(mp3.length);
    await request(app).post("/api/voice/status").send({ message: "Arbitrary text" }).expect(400);
  });
});
