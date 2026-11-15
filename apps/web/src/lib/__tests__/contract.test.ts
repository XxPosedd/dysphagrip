// Contract test: what the dashboard sends must pass the server's own validator.
import { describe, expect, it } from "vitest";
import { parseSessionInput } from "../../../../../server/src/validation";
import { SessionRecorder, buildSessionPayload, storedToSummary } from "../session";
import type { AudioFrame, StoredSession } from "../types";
import { VOICE_PHRASES } from "../../../../../server/src/voice/phrases";
import { VOICE } from "../voicePhrases";

const T0 = 1_800_000_000_000;
const frame = (t: number, activity: boolean): AudioFrame => ({
  type: "audio_frame", seq: 0, source: "device", fs: 48000, sample_index: 0, n_samples: 2400,
  t_start_unix_ms: T0 + t - 50.25, t_end_unix_ms: T0 + t + 0.37, dropped_samples: 0,
  waveform: { min: [0], max: [0] }, spectrum: { fmax_hz: 4000, db: [-100] },
  features: { rms_dbfs: -40.3, peak: 0.1, clip_fraction: 0, zcr: 0.1, spectral_centroid_hz: 500, dominant_hz: 300,
    band_fraction: { low: 0.5, mid: 0.3, high: 0.2 }, hum_ratio: 0, noise_floor_dbfs: -70.4, snr_db: 30, activity },
  quality: { label: "ok", reasons: [] },
});

describe("dashboard → API session contract", () => {
  it("a recorded session's payload passes server validation unchanged in meaning", () => {
    const rec = new SessionRecorder(T0, { kind: "device", samplerate: 48000, anchor_unix_ms: T0, anchor_method: "x",
      samples_captured: 0, wall_minus_sample_clock_ms: 0, device_name: "USB Audio CODEC", channel: 1, um2_match: "possible" });
    for (let t = 50; t <= 4000; t += 50) rec.ingest(frame(t, t > 1000 && t < 1600));
    rec.addManualMarker(2500.6, "sip");
    const summary = rec.stop(T0 + 4000);
    const payload = buildSessionPayload("x".repeat(200), summary, rec.markers);

    const parsed = parseSessionInput(JSON.parse(JSON.stringify(payload)));
    expect(parsed.label).toHaveLength(120);
    expect(parsed.markers.map((m) => m.kind)).toEqual(["audio_activity", "manual"]);
    expect(parsed.markers[1]).toMatchObject({ t_ms: 2501, note: "sip", duration_ms: null });
    expect(parsed.duration_ms).toBe(4000);
    expect(parsed.audio_source).toBe("USB Audio CODEC · ch 1");
    expect(parsed.quality_ms.ok).toBe(4000);
  });

  it("converts a stored session back to the summary shape", () => {
    const stored: StoredSession = {
      id: "6f1c1e2a-0000-4000-8000-000000000000", label: "s", started_at: "2026-11-14T15:00:00.000Z",
      ended_at: "2026-11-14T15:00:10.000Z", duration_ms: 10_000, audio_source: "UM2 · ch 1", audio_source_kind: "device",
      frames: 200, dropped_samples: 0, activity_ms: 500, activity_segments: 1, manual_markers: 0,
      median_noise_floor_dbfs: -70, max_rms_dbfs: -20, motion_connected: false, created_at: "2026-11-14T15:00:11.000Z",
      quality_ms: { ok: 10_000, no_signal: 0, clipping: 0, mains_hum: 0 },
    };
    const s = storedToSummary(stored);
    expect(s.duration_ms).toBe(10_000);
    expect(s.ended_at).toBe(stored.ended_at);
    expect(s.quality_ms.ok).toBe(10_000);
  });
});


describe("dashboard voice phrases ↔ server allowlist", () => {
  it("every dashboard phrase is approved by the server, and vice versa", () => {
    const web = new Set<string>(Object.values(VOICE));
    const server = new Set<string>(VOICE_PHRASES);
    expect([...web].filter((p) => !server.has(p))).toEqual([]);
    expect([...server].filter((p) => !web.has(p))).toEqual([]);
  });
});
