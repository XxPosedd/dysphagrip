import express, { type Response } from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { storeFromEnv, type SessionStore } from "./db.js";
import { speakStatus } from "./integrations/elevenlabs.js";
import { isUuid, parseSessionInput, ValidationError } from "./validation.js";

export interface AppDeps {
  /** Session persistence. `undefined` -> build from DATABASE_URL; `null` -> explicitly not configured. */
  store?: SessionStore | null;
}

/** Never echo connection strings back to clients or logs. */
export function redact(message: string): string {
  return message.replace(/postgres(?:ql)?:\/\/[^\s'"]+/gi, "postgres://[redacted]");
}

export function createApp(deps: AppDeps = {}) {
  const store = deps.store === undefined ? storeFromEnv() : deps.store;
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "2mb" }));

  const notConfigured = (res: Response) =>
    res.status(503).json({ error: "Neon is not configured", detail: "Set DATABASE_URL in .env and run npm run db:migrate --prefix server" });

  const dbFailure = (res: Response, error: unknown) => {
    const detail = redact(error instanceof Error ? error.message : String(error));
    console.error("Database error:", detail);
    res.status(502).json({ error: "Database request failed", detail });
  };

  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      service: "dysphagrip-api",
      integrations: {
        database: store !== null,
        elevenlabs: Boolean(process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_VOICE_ID),
        brightdata: Boolean(process.env.BRIGHTDATA_API_TOKEN && process.env.BRIGHTDATA_DATASET_ID),
      },
    });
  });

  // Live connectivity check (health only reports whether a URL is configured).
  app.get("/api/db/status", async (_req, res) => {
    if (!store) return void notConfigured(res);
    const t0 = Date.now();
    try {
      await store.ping();
      res.json({ ok: true, latency_ms: Date.now() - t0 });
    } catch (error) {
      dbFailure(res, error);
    }
  });

  app.get("/api/sessions", async (req, res) => {
    if (!store) return void notConfigured(res);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    try {
      res.json({ sessions: await store.list(limit) });
    } catch (error) {
      dbFailure(res, error);
    }
  });

  app.post("/api/sessions", async (req, res) => {
    if (!store) return void notConfigured(res);
    let input;
    try {
      input = parseSessionInput(req.body);
    } catch (error) {
      if (error instanceof ValidationError) return void res.status(400).json({ error: "Invalid session", detail: error.message });
      throw error;
    }
    try {
      res.status(201).json({ session: await store.create(input) });
    } catch (error) {
      dbFailure(res, error);
    }
  });

  app.get("/api/sessions/:id", async (req, res) => {
    if (!store) return void notConfigured(res);
    if (!isUuid(req.params.id)) return void res.status(400).json({ error: "Invalid session id" });
    try {
      const session = await store.get(req.params.id);
      if (!session) return void res.status(404).json({ error: "Session not found" });
      res.json({ session });
    } catch (error) {
      dbFailure(res, error);
    }
  });

  app.delete("/api/sessions/:id", async (req, res) => {
    if (!store) return void notConfigured(res);
    if (!isUuid(req.params.id)) return void res.status(400).json({ error: "Invalid session id" });
    try {
      const removed = await store.remove(req.params.id);
      if (!removed) return void res.status(404).json({ error: "Session not found" });
      res.status(204).end();
    } catch (error) {
      dbFailure(res, error);
    }
  });

  app.post("/api/voice/status", async (req, res) => {
    const message = typeof req.body?.message === "string" ? req.body.message.slice(0, 300) : "";
    if (!message) return void res.status(400).json({ error: "message is required" });
    try {
      const audio = await speakStatus(message);
      if (!audio) return void res.status(501).json({ error: "ElevenLabs is not configured" });
      res.setHeader("Content-Type", "audio/mpeg");
      res.send(Buffer.from(audio));
    } catch (error) {
      res.status(502).json({ error: "Voice service failed", detail: String(error) });
    }
  });

  // Bright Data is implemented in Phase 8. Until then this endpoint is honest about being empty.
  app.get("/api/resources", (_req, res) => {
    res.json({ source: "not_configured", resources: [], note: "Bright Data integration is not implemented yet (Phase 8)." });
  });

  app.use("/api", (_req, res) => res.status(404).json({ error: "Not found" }));

  // Malformed JSON bodies and other unexpected errors -> JSON, never an HTML stack trace.
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = (error as { status?: number }).status;
    if (status === 400) return void res.status(400).json({ error: "Malformed JSON body" });
    if (status === 413) return void res.status(413).json({ error: "Payload too large" });
    console.error(error);
    res.status(500).json({ error: "Internal server error" });
  });

  if (process.env.NODE_ENV === "production") {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const webDist = path.resolve(here, "../../apps/web/dist");
    app.use(express.static(webDist));
    app.get("*", (_req, res) => res.sendFile(path.join(webDist, "index.html")));
  }

  return app;
}
