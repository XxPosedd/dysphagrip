/**
 * ElevenLabs text-to-speech, server-side only. The API key never leaves this process.
 * Docs: POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}?output_format=…  (header: xi-api-key)
 */

export interface VoiceInfo {
  id: string;
  name: string | null;
}

/** Abstraction the API routes depend on (lets tests run without network or credentials). */
export interface TextToSpeech {
  readonly configured: boolean;
  readonly modelId: string | null;
  /** Returns MP3 bytes. Throws TtsError on failure. */
  synthesize(text: string): Promise<{ audio: Uint8Array; cached: boolean }>;
  voiceInfo(): Promise<VoiceInfo | null>;
  /** True when this phrase can be served without calling ElevenLabs. */
  isCached(text: string): boolean;
}

export class TtsError extends Error {
  constructor(message: string, readonly status: number, readonly retryable = false) {
    super(message);
  }
}

export interface ElevenLabsOptions {
  apiKey: string;
  voiceId: string;
  modelId?: string;
  outputFormat?: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_MODEL = "eleven_multilingual_v2"; // ElevenLabs' documented default
const DEFAULT_FORMAT = "mp3_44100_128";          // available on every plan tier

/** Translate ElevenLabs HTTP failures into messages that are useful and never contain the key. */
export function describeElevenLabsError(status: number, body: string): TtsError {
  let detail = "";
  try {
    const j = JSON.parse(body) as { detail?: unknown };
    const d = j.detail as { message?: string; status?: string } | Array<{ msg?: string }> | string | undefined;
    if (typeof d === "string") detail = d;
    else if (Array.isArray(d)) detail = d.map((x) => x.msg).filter(Boolean).join("; ");
    else if (d && typeof d === "object") detail = d.message ?? d.status ?? "";
  } catch { /* not JSON */ }
  const suffix = detail ? ` (${detail.slice(0, 200)})` : "";
  switch (status) {
    case 401: return new TtsError(`ElevenLabs rejected the API key${suffix}`, 502);
    case 402: return new TtsError(`ElevenLabs plan does not allow this request${suffix}`, 502);
    case 404: return new TtsError(`ElevenLabs voice not found: check ELEVENLABS_VOICE_ID${suffix}`, 502);
    case 422: return new TtsError(`ElevenLabs rejected the request${suffix}`, 502);
    case 429: return new TtsError(`ElevenLabs rate limit or quota reached${suffix}`, 503, true);
    default:
      return new TtsError(`ElevenLabs returned HTTP ${status}${suffix}`, 502, status >= 500);
  }
}

export class ElevenLabsTts implements TextToSpeech {
  readonly configured = true;
  readonly modelId: string;
  private readonly cache = new Map<string, Uint8Array>();
  private readonly inflight = new Map<string, Promise<Uint8Array>>();
  private voice: VoiceInfo | null | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: ElevenLabsOptions) {
    this.modelId = opts.modelId || DEFAULT_MODEL;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private get base() {
    return (this.opts.baseUrl ?? "https://api.elevenlabs.io").replace(/\/$/, "");
  }

  private async call(path: string, init: RequestInit): Promise<Response> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs ?? 15_000);
    try {
      return await this.fetchImpl(`${this.base}${path}`, {
        ...init,
        signal: ctrl.signal,
        headers: { "xi-api-key": this.opts.apiKey, ...(init.headers as Record<string, string>) },
      });
    } catch (e) {
      const aborted = (e as Error).name === "AbortError";
      throw new TtsError(aborted ? "ElevenLabs did not respond in time" : "Could not reach ElevenLabs", 504, true);
    } finally {
      clearTimeout(timer);
    }
  }

  isCached(text: string): boolean {
    return this.cache.has(text);
  }

  async synthesize(text: string): Promise<{ audio: Uint8Array; cached: boolean }> {
    const hit = this.cache.get(text);
    if (hit) return { audio: hit, cached: true };
    // Collapse concurrent requests for the same phrase into one API call.
    let pending = this.inflight.get(text);
    if (!pending) {
      pending = this.fetchAudio(text).finally(() => this.inflight.delete(text));
      this.inflight.set(text, pending);
    }
    const audio = await pending;
    this.cache.set(text, audio);
    return { audio, cached: false };
  }

  private async fetchAudio(text: string): Promise<Uint8Array> {
    const fmt = encodeURIComponent(this.opts.outputFormat || DEFAULT_FORMAT);
    const res = await this.call(`/v1/text-to-speech/${encodeURIComponent(this.opts.voiceId)}?output_format=${fmt}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "audio/mpeg" },
      body: JSON.stringify({
        text,
        model_id: this.modelId,
        voice_settings: { stability: 0.6, similarity_boost: 0.75, style: 0, use_speaker_boost: true },
      }),
    });
    if (!res.ok) throw describeElevenLabsError(res.status, await res.text().catch(() => ""));
    const audio = new Uint8Array(await res.arrayBuffer());
    if (audio.byteLength < 100) throw new TtsError("ElevenLabs returned empty audio", 502, true);
    return audio;
  }

  /** Voice display name for the UI. Failures (e.g. a key without voices_read permission) are non-fatal. */
  async voiceInfo(): Promise<VoiceInfo | null> {
    if (this.voice !== undefined) return this.voice;
    try {
      const res = await this.call(`/v1/voices/${encodeURIComponent(this.opts.voiceId)}`, { method: "GET" });
      if (!res.ok) return { id: this.opts.voiceId, name: null };
      const j = (await res.json()) as { name?: unknown };
      this.voice = { id: this.opts.voiceId, name: typeof j.name === "string" ? j.name : null };
    } catch {
      return { id: this.opts.voiceId, name: null };
    }
    return this.voice;
  }
}

export const notConfiguredTts: TextToSpeech = {
  configured: false,
  modelId: null,
  async synthesize() {
    throw new TtsError("ElevenLabs is not configured", 501);
  },
  async voiceInfo() {
    return null;
  },
  isCached() {
    return false;
  },
};

export function ttsFromEnv(): TextToSpeech {
  const apiKey = process.env.ELEVENLABS_API_KEY?.trim();
  const voiceId = process.env.ELEVENLABS_VOICE_ID?.trim();
  if (!apiKey || !voiceId) return notConfiguredTts;
  return new ElevenLabsTts({ apiKey, voiceId, modelId: process.env.ELEVENLABS_MODEL_ID?.trim() || undefined });
}

/** Simple fixed-window limiter for uncached synthesis calls (protects the ElevenLabs quota). */
export class RateLimiter {
  private hits: number[] = [];
  constructor(private readonly max: number, private readonly windowMs: number, private readonly now = () => Date.now()) {}
  tryTake(): boolean {
    const t = this.now();
    this.hits = this.hits.filter((h) => t - h < this.windowMs);
    if (this.hits.length >= this.max) return false;
    this.hits.push(t);
    return true;
  }
}
