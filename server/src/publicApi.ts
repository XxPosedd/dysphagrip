import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Express } from "express";
import { looksLikeMp3 } from "./integrations/elevenlabs.js";

const cues = [
  { message: "Recording started.", name: "started" },
  { message: "Recording stopped.", name: "stopped" },
];

// Load complete, matching pairs once so previews work without external calls.
function loadPair(directory: string, extension: "mp3" | "m4a") {
  const clips = new Map<string, Buffer>();
  try {
    for (const { message, name } of cues) {
      const audio = readFileSync(path.join(directory, name + "." + extension));
      const valid = extension === "mp3" ? looksLikeMp3(audio) : audio.toString("ascii", 4, 8) === "ftyp";
      if (!valid) return null;
      clips.set(message, audio);
    }
  } catch { return null; }
  return clips;
}

export function mountPublicApi(app: Express) {
  const eleven = loadPair(process.env.DYSPHAGRIP_PUBLIC_VOICE_DIR || "/app/status-voice", "mp3");
  const bundled = loadPair(fileURLToPath(new URL("../assets/status/", import.meta.url)), "m4a");
  const clips = eleven ?? bundled;
  const provider = eleven ? "elevenlabs" : bundled ? "macos" : null;
  const phrases = cues.map(cue => cue.message);

  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true, service: "dysphagrip-api", local_dashboard: false, public_dashboard: true, voice_mode: "prerecorded",
      integrations: {
        database: false, elevenlabs: Boolean(eleven),
        brightdata: Boolean(process.env.BRIGHTDATA_API_TOKEN?.trim() && process.env.BRIGHTDATA_ZONE?.trim()),
      },
    });
  });
  app.get("/api/voice", (_req, res) => {
    res.json({
      configured: Boolean(eleven), provider, fallback_provider: bundled ? "macos" : null,
      mode: "prerecorded", model_id: null, voice: null, phrases,
    });
  });
  app.post("/api/voice/status", (req, res) => {
    const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
    if (!phrases.includes(message)) return void res.status(400).json({ error: "Select a recording announcement.", allowed: phrases });
    if (!clips || !provider) return void res.status(503).json({ error: "The voice preview is unavailable." });
    res.setHeader("X-Voice-Provider", provider);
    res.setHeader("X-Voice-Cache", "hit");
    res.type(eleven ? "audio/mpeg" : "audio/mp4").send(clips.get(message));
  });
  app.use("/audio", (_req, res) => res.status(404).json({ error: "Not found" }));
}
