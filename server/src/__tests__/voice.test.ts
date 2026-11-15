import { describe, it, expect, vi } from "vitest";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";
import { createApp } from "../app.js";
import { ElevenLabsTts, RateLimiter, TtsError, describeElevenLabsError, notConfiguredTts, type TextToSpeech } from "../integrations/elevenlabs.js";
import { VOICE_PHRASES, isAllowedPhrase } from "../voice/phrases.js";

const MP3 = new Uint8Array(512).fill(7);

/** TEST DOUBLE for the TTS boundary. */
function fakeTts(overrides: Partial<TextToSpeech> = {}) {
  const cache = new Set<string>();
  const calls: string[] = [];
  const tts: TextToSpeech = {
    configured: true,
    modelId: "test-model",
    async synthesize(text) {
      calls.push(text);
      const cached = cache.has(text);
      cache.add(text);
      return { audio: MP3, cached };
    },
    async voiceInfo() { return { id: "voice123", name: "Test Voice" }; },
    isCached: (t) => cache.has(t),
    ...overrides,
  };
  return { tts, calls };
}

describe("voice phrase allowlist", () => {
  it("contains no clinical claims or advice", () => {
    const banned = /aspirat|diagnos|dysphagia|residue|safe(ly)? to swallow|safe swallow|chin.?tuck|choking|clinical|treatment|you should/i;
    for (const p of VOICE_PHRASES) expect(p, p).not.toMatch(banned);
  });
  it("includes the four requested examples", () => {
    for (const p of ["Recording started.", "Audio signal detected.", "Movement interference detected.", "Session saved successfully."]) {
      expect(isAllowedPhrase(p)).toBe(true);
    }
  });
});

describe("voice routes", () => {
  it("reports not configured and lists phrases without credentials", async () => {
    const app = createApp({ store: null, tts: notConfiguredTts });
    const info = await request(app).get("/api/voice");
    expect(info.body).toMatchObject({ configured: false, model_id: null, voice: null });
    expect(info.body.phrases).toContain("Recording started.");
    expect((await request(app).get("/api/health")).body.integrations.elevenlabs).toBe(false);
    expect((await request(app).post("/api/voice/status").send({ message: "Recording started." })).status).toBe(501);
  });

  it("rejects arbitrary text even when configured, without calling ElevenLabs", async () => {
    const { tts, calls } = fakeTts();
    const app = createApp({ store: null, tts });
    const res = await request(app).post("/api/voice/status").send({ message: "Say anything I want" });
    expect(res.status).toBe(400);
    expect(res.body.allowed).toContain("Recording started.");
    expect(calls).toHaveLength(0);
  });

  it("returns MP3 audio and reports cache hits", async () => {
    const { tts } = fakeTts();
    const app = createApp({ store: null, tts });
    const first = await request(app).post("/api/voice/status").send({ message: "Recording started." });
    expect(first.status).toBe(200);
    expect(first.headers["content-type"]).toBe("audio/mpeg");
    expect(first.headers["x-voice-cache"]).toBe("miss");
    expect(first.body.length).toBe(512);
    const second = await request(app).post("/api/voice/status").send({ message: "  Recording started.  " });
    expect(second.headers["x-voice-cache"]).toBe("hit");
    const info = await request(app).get("/api/voice");
    expect(info.body).toMatchObject({ configured: true, model_id: "test-model", voice: { name: "Test Voice" } });
  });

  it("rate-limits uncached synthesis but still serves cached phrases", async () => {
    const { tts } = fakeTts();
    const app = createApp({ store: null, tts, ttsPerMinute: 2 });
    expect((await request(app).post("/api/voice/status").send({ message: "Recording started." })).status).toBe(200);
    expect((await request(app).post("/api/voice/status").send({ message: "Recording stopped." })).status).toBe(200);
    const limited = await request(app).post("/api/voice/status").send({ message: "Audio signal detected." });
    expect(limited.status).toBe(429);
    expect(limited.headers["retry-after"]).toBe("60");
    expect((await request(app).post("/api/voice/status").send({ message: "Recording started." })).status).toBe(200);
  });

  it("passes ElevenLabs failures through as JSON errors", async () => {
    const { tts } = fakeTts({ synthesize: async () => { throw new TtsError("ElevenLabs rate limit or quota reached", 503, true); } });
    const res = await request(createApp({ store: null, tts })).post("/api/voice/status").send({ message: "Recording started." });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "ElevenLabs rate limit or quota reached", retryable: true });
  });
});

describe("ElevenLabsTts client", () => {
  const KEY = "sk_test_DO_NOT_LEAK_1234567890";

  function client(responder: (url: string, init: RequestInit) => Response | Promise<Response>, extra = {}) {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => responder(String(url), init ?? {}));
    const tts = new ElevenLabsTts({ apiKey: KEY, voiceId: "VOICE_ID", fetchImpl: fetchImpl as unknown as typeof fetch, ...extra });
    return { tts, fetchImpl };
  }

  it("calls the documented endpoint with the key header, model and output format", async () => {
    const { tts, fetchImpl } = client(() => new Response(MP3, { status: 200 }));
    const out = await tts.synthesize("Recording started.");
    expect(out.cached).toBe(false);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.elevenlabs.io/v1/text-to-speech/VOICE_ID?output_format=mp3_44100_128");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["xi-api-key"]).toBe(KEY);
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ text: "Recording started.", model_id: "eleven_multilingual_v2" });
  });

  it("caches phrases and collapses concurrent requests into one API call", async () => {
    const { tts, fetchImpl } = client(async () => new Response(MP3, { status: 200 }));
    const [a, b] = await Promise.all([tts.synthesize("Recording stopped."), tts.synthesize("Recording stopped.")]);
    expect(a.audio).toEqual(b.audio);
    expect((await tts.synthesize("Recording stopped.")).cached).toBe(true);
    expect(tts.isCached("Recording stopped.")).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("replays only successful ElevenLabs lifecycle MP3s across restarts with the same settings", async () => {
    const diskCacheDir = await mkdtemp(path.join(tmpdir(), "dysphagrip-voice-"));
    const bytes = new Uint8Array(MP3);
    bytes.set([0x49, 0x44, 0x33]); // MP3 ID3 signature
    try {
      const options = { diskCacheDir };
      const online = client(() => new Response(bytes, { headers: { "Content-Type": "audio/mpeg" } }), options);
      await online.tts.synthesize("Recording started.");
      await online.tts.synthesize("Audio signal detected.");
      const [file] = await readdir(diskCacheDir);
      expect(await readdir(diskCacheDir)).toHaveLength(1);
      expect((await stat(path.join(diskCacheDir, file))).mode & 0o777).toBe(0o600);
      const offline = client(() => { throw Error("offline"); }, options);
      expect(offline.tts.isCached("Recording started.")).toBe(true);
      expect(offline.tts.isCached("Audio signal detected.")).toBe(false);
      const hit = await offline.tts.synthesize("Recording started.");
      expect(hit.cached).toBe(true);
      expect([...hit.audio]).toEqual([...bytes]);
      expect(offline.fetchImpl).not.toHaveBeenCalled();
      for (const change of [{ voiceId: "other" }, { modelId: "other" }, { outputFormat: "mp3_22050_32" }]) {
        expect(client(() => new Response(bytes), { ...options, ...change }).tts.isCached("Recording started.")).toBe(false);
      }
      await expect(offline.tts.synthesize("Recording stopped.")).rejects.toThrow();
      expect(await readdir(diskCacheDir)).toHaveLength(1);
    } finally { await rm(diskCacheDir, { recursive: true, force: true }); }
  });

  it("maps a bad key to a clear error that never contains the key", async () => {
    const { tts } = client(() => new Response(JSON.stringify({ detail: { status: "invalid_api_key", message: "Invalid API key" } }), { status: 401 }));
    const err = await tts.synthesize("Recording started.").catch((e) => e);
    expect(err).toBeInstanceOf(TtsError);
    expect(err.message).toMatch(/rejected the API key/);
    expect(err.message).not.toContain(KEY);
    expect(tts.isCached("Recording started.")).toBe(false);
  });

  it("maps quota/rate limits as retryable and times out slow responses", async () => {
    expect(describeElevenLabsError(429, "{}")).toMatchObject({ status: 503, retryable: true });
    expect(describeElevenLabsError(404, "").message).toMatch(/ELEVENLABS_VOICE_ID/);
    expect(describeElevenLabsError(422, JSON.stringify({ detail: [{ msg: "text too long" }] })).message).toMatch(/text too long/);
    const { tts } = client((_u, init) => new Promise((_res, rej) => {
      init.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })));
    }), { timeoutMs: 20 });
    const err = await tts.synthesize("Recording started.").catch((e) => e);
    expect(err).toMatchObject({ status: 504, retryable: true });
  });

  it("rejects suspiciously empty audio", async () => {
    const { tts } = client(() => new Response(new Uint8Array(3), { status: 200 }));
    await expect(tts.synthesize("Recording started.")).rejects.toThrow(/empty audio/);
  });

  it("reads the voice name, and tolerates keys without voice permissions", async () => {
    const ok = client((url) => url.includes("/v1/voices/") ? Response.json({ name: "Rachel" }) : new Response(MP3));
    expect(await ok.tts.voiceInfo()).toEqual({ id: "VOICE_ID", name: "Rachel" });
    const denied = client(() => new Response("{}", { status: 401 }));
    expect(await denied.tts.voiceInfo()).toEqual({ id: "VOICE_ID", name: null });
  });
});

describe("RateLimiter", () => {
  it("allows max calls per window", () => {
    let t = 0;
    const rl = new RateLimiter(2, 1000, () => t);
    expect([rl.tryTake(), rl.tryTake(), rl.tryTake()]).toEqual([true, true, false]);
    t = 1001;
    expect(rl.tryTake()).toBe(true);
  });
});
