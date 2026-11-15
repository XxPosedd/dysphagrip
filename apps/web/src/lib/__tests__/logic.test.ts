import { describe, expect, it } from "vitest";
import { ActivitySegmenter, QualityDebouncer } from "../events";
import { formatDuration, formatHz, formatSessionTime } from "../format";
import { SessionRecorder, describeSource } from "../session";
import { parseAudioMessage } from "../stream";
import type { AudioFrame, QualityLabel } from "../types";

const T0 = 1_800_000_000_000;

function frame(t_ms: number, opts: Partial<{ activity: boolean; quality: QualityLabel; rms: number; dropped: number }> = {}): AudioFrame {
  return {
    type: "audio_frame", seq: 0, source: "device", fs: 48000, sample_index: 0, n_samples: 2400,
    t_start_unix_ms: T0 + t_ms - 50, t_end_unix_ms: T0 + t_ms, dropped_samples: opts.dropped ?? 0,
    waveform: { min: [0], max: [0] }, spectrum: { fmax_hz: 4000, db: [-100] },
    features: { rms_dbfs: opts.rms ?? -50, peak: 0.01, clip_fraction: 0, zcr: 0.1, spectral_centroid_hz: 500,
      dominant_hz: 300, band_fraction: { low: 0.5, mid: 0.3, high: 0.2 }, hum_ratio: 0, noise_floor_dbfs: -70,
      snr_db: 20, activity: opts.activity ?? false },
    quality: { label: opts.quality ?? "ok", reasons: [] },
  };
}

describe("ActivitySegmenter", () => {
  it("ignores blips shorter than minOn", () => {
    const s = new ActivitySegmenter(150, 200);
    expect(s.push(0, true)).toBeNull();
    expect(s.push(50, true)).toBeNull();
    expect(s.push(100, false)).toBeNull();
    expect(s.current).toBeNull();
  });

  it("opens after minOn and closes after minOff, bridging short gaps", () => {
    const s = new ActivitySegmenter(150, 200);
    for (let t = 0; t <= 400; t += 50) s.push(t, true);
    expect(s.current).toEqual({ start_ms: 0, end_ms: 400 });
    expect(s.push(450, false)).toBeNull();          // 50 ms gap: bridged
    s.push(500, true);
    s.push(550, false);
    expect(s.push(650, false)).toBeNull();          // 150 ms since last activity: still open
    expect(s.push(700, false)).toEqual({ start_ms: 0, end_ms: 500 }); // 200 ms quiet: closes at last activity
  });

  it("emits a segment with correct bounds", () => {
    const s = new ActivitySegmenter(100, 200);
    let seg = null;
    for (let t = 0; t <= 300; t += 50) seg = s.push(t, true) ?? seg;
    for (let t = 350; t <= 600 && !seg; t += 50) seg = s.push(t, false);
    expect(seg).toEqual({ start_ms: 0, end_ms: 300 });
  });

  it("splits very long activity at maxMs", () => {
    const s = new ActivitySegmenter(100, 200, 1000);
    const segs = [];
    for (let t = 0; t <= 2500; t += 50) { const r = s.push(t, true); if (r) segs.push(r); }
    expect(segs.length).toBe(2);
    expect(segs[0].end_ms - segs[0].start_ms).toBe(1000);
  });

  it("flush closes an open segment", () => {
    const s = new ActivitySegmenter(100, 200);
    for (let t = 0; t <= 300; t += 50) s.push(t, true);
    expect(s.flush(320)).toEqual({ start_ms: 0, end_ms: 300 });
    expect(s.flush(400)).toBeNull();
  });
});

describe("QualityDebouncer", () => {
  it("accepts the first label immediately and holds changes for holdMs", () => {
    const q = new QualityDebouncer(1000);
    expect(q.push(0, "ok")).toBe("ok");
    expect(q.push(100, "clipping")).toBeNull();
    expect(q.push(500, "ok")).toBeNull();           // flicker discarded
    expect(q.push(600, "clipping")).toBeNull();
    expect(q.push(1500, "clipping")).toBeNull();     // only 900 ms
    expect(q.push(1600, "clipping")).toBe("clipping");
    expect(q.label).toBe("clipping");
  });
});

describe("SessionRecorder", () => {
  const src = { kind: "device", samplerate: 48000, anchor_unix_ms: T0, anchor_method: "x", samples_captured: 0,
    wall_minus_sample_clock_ms: 0, device_index: 3, device_name: "UM2", channel: 1, um2_match: "strong" as const };

  it("builds timeline, activity markers, quality time and summary", () => {
    const rec = new SessionRecorder(T0, src);
    const seen: string[] = [];
    rec.onMarker.push((m) => seen.push(m.kind));
    for (let t = 50; t <= 1000; t += 50) rec.ingest(frame(t, { activity: t >= 300 && t <= 600 }));
    rec.addManualMarker(700, "sip");
    for (let t = 1050; t <= 3000; t += 50) rec.ingest(frame(t, { quality: "no_signal", rms: -90 }));
    const s = rec.stop(T0 + 3000);

    expect(rec.points.length).toBe(60);
    expect(s.duration_ms).toBe(3000);
    expect(s.activity_segments).toBe(1);
    expect(s.activity_ms).toBe(300);
    expect(s.manual_markers).toBe(1);
    expect(s.quality_ms.ok + s.quality_ms.no_signal).toBe(3000);   // every ms of the session is attributed
    expect(s.quality_ms.no_signal).toBeGreaterThan(1900);
    expect(s.max_rms_dbfs).toBe(-50);
    expect(s.audio_source).toBe("Behringer UM2 · ch 1");
    expect(s.ended_at).toBe(new Date(T0 + 3000).toISOString());
    expect(seen).toContain("audio_activity");
    expect(seen).toContain("quality");               // no_signal episode closed at stop
    const q = rec.markers.find((m) => m.kind === "quality")!;
    expect(q.label).toBe("No signal");
  });

  it("notifies debounced quality changes with the previous label", () => {
    const rec = new SessionRecorder(T0, src);
    const changes: Array<[string, string | null]> = [];
    rec.onQualityChange.push((l, p) => changes.push([l, p]));
    rec.ingest(frame(50));
    for (let t = 100; t <= 1300; t += 50) rec.ingest(frame(t, { quality: "clipping" }));
    expect(changes).toEqual([["ok", null], ["clipping", "ok"]]);
  });

  it("ignores frames captured before the session started and after it stopped", () => {
    const rec = new SessionRecorder(T0, src);
    rec.ingest(frame(-100));
    expect(rec.points.length).toBe(0);
    rec.ingest(frame(50));
    rec.stop(T0 + 100);
    rec.ingest(frame(150));
    expect(rec.points.length).toBe(1);
  });

  it("labels file playback sources", () => {
    expect(describeSource({ ...src, kind: "file", file: "demo.wav" })).toBe("file playback: demo.wav");
  });
});

describe("parseAudioMessage", () => {
  it("accepts valid frames and status messages", () => {
    expect(parseAudioMessage(JSON.stringify(frame(50)))?.type).toBe("audio_frame");
    expect(parseAudioMessage(JSON.stringify({ type: "hello", running: false }))?.type).toBe("hello");
    expect(parseAudioMessage(JSON.stringify({ type: "error", message: "x" }))?.type).toBe("error");
  });
  it("rejects malformed input", () => {
    expect(parseAudioMessage("not json")).toBeNull();
    expect(parseAudioMessage(JSON.stringify({ type: "audio_frame" }))).toBeNull();
    expect(parseAudioMessage(JSON.stringify({ type: "status" }))).toBeNull();
    expect(parseAudioMessage(JSON.stringify({ type: "something_else" }))).toBeNull();
  });
});

describe("format", () => {
  it("formats durations and frequencies", () => {
    expect(formatDuration(65_000)).toBe("01:05");
    expect(formatDuration(3_725_000)).toBe("1:02:05");
    expect(formatSessionTime(83_450)).toBe("01:23.4");
    expect(formatHz(440)).toBe("440 Hz");
    expect(formatHz(1500)).toBe("1.5 kHz");
  });
});
