import { describe, expect, it } from "vitest";
import { FusionDetector } from "../fusion";
import { SessionRecorder, buildSessionPayload } from "../session";
import { parseSessionInput } from "../../../../../server/src/validation";
import type { AudioFrame } from "../types";

function motion(ms: number, gyro = 0) {
  return { t_unix_ms: ms, ax: 0, ay: 0, az: 1, gx: gyro, gy: 0, gz: 0 };
}
function calibrate(d: FusionDetector) {
  for (let ms = 0; ms <= 8000; ms += 50) {
    d.onAudio(ms, 0.001);
    d.onMotion(ms, motion(ms));
  }
}

describe("Proyecto 2 fusion", () => {
  it("waits for five seconds of overlapping measurements, including at least twenty deltas", () => {
    const detector = new FusionDetector();
    for (let ms = 0; ms <= 6000; ms += 50) detector.onAudio(ms, 0.001);
    expect(detector.calibrated).toBe(false);
    for (let ms = 6050; ms <= 11050; ms += 50) {
      detector.onAudio(ms, 0.001);
      if ((ms - 6050) % 500 === 0) detector.onMotion(ms, motion(ms));
    }
    expect(detector.calibrated).toBe(false);
    for (let ms = 11100; ms <= 15100; ms += 50) {
      detector.onAudio(ms, 0.001);
      detector.onMotion(ms, motion(ms));
    }
    expect(detector.calibrated).toBe(true);
  });

  it("excludes preparation transients and audio recorded before motion connects", () => {
    const detector = new FusionDetector();
    for (let ms = 0; ms <= 4000; ms += 50) detector.onAudio(ms, 0.8);
    for (let ms = 4050; ms <= 12050; ms += 50) {
      const preparing = ms < 7050;
      detector.onAudio(ms, preparing ? 0.8 : 0.001);
      detector.onMotion(ms, motion(ms, preparing ? 15 : 0));
      if (ms === 6050) expect(detector.status(ms)).toContain("Get ready");
      if (ms === 9050) expect(detector.status(ms)).toContain("Calibrating");
    }
    expect(detector.calibrated).toBe(true);
    detector.onAudio(12100, 0.005);
    expect(detector.onMotion(12100, motion(12100, 0.2))).toMatchObject({ audioRms: 0.005 });
  });

  it("requires coincidence, suppresses held signals, then detects a new released pair", () => {
    const detector = new FusionDetector();
    calibrate(detector);
    expect(detector.onAudio(8050, 0.005)).toBeNull();
    for (let ms = 8050; ms <= 8700; ms += 50) detector.onMotion(ms, motion(ms));
    expect(detector.onMotion(8701, motion(8701, 1))).toBeNull();
    expect(detector.onAudio(8750, 0.005)).toMatchObject({ ms: 8750, gapMs: 49, audioRms: 0.005, imuActivity: 1 });
    for (let ms = 8800; ms <= 11000; ms += 50) {
      expect(detector.onMotion(ms, motion(ms, 1))).toBeNull();
      expect(detector.onAudio(ms, 0.005)).toBeNull();
    }
    detector.onMotion(11050, motion(11050));
    detector.onAudio(11050, 0);
    detector.onAudio(11100, 0.005);
    expect(detector.onMotion(11110, motion(11110, 3))).toMatchObject({ ms: 11110 });
    expect(detector.onMotion(13000, motion(13000, 100))).toBeNull();
    expect(detector.calibrated).toBe(false);
  });

  it("persists observed labels independently from fused candidates with source measurements", () => {
    const rec = new SessionRecorder(0, null);
    function send(ms: number, rms: number, gyro: number) {
      const frame: AudioFrame = {
        type: "audio_frame", source: "device", seq: ms, fs: 48000, sample_index: 0, n_samples: 2400,
        t_start_unix_ms: ms - 50, t_end_unix_ms: ms, dropped_samples: 0, waveform: { min: [], max: [] },
        spectrum: { fmax_hz: 4000, db: [] }, quality: { label: "ok", reasons: [] },
        features: { raw_rms: rms, rms_dbfs: -30, peak: 0, clip_fraction: 0, zcr: 0, spectral_centroid_hz: 0,
          dominant_hz: 0, band_fraction: { low: 0, mid: 0, high: 0 }, hum_ratio: 0, noise_floor_dbfs: -40,
          snr_db: 0, activity: false },
      };
      rec.ingest(frame);
      rec.ingestMotion({ type: "motion_frame", features: {}, samples: [motion(ms, gyro)] });
    }
    rec.markObservation("coughing", 100);
    for (let ms = 0; ms <= 8000; ms += 50) send(ms, 0.001, 0);
    send(8050, 0.03, 2);
    rec.markObservation("swallowing_saliva", 8100);
    const summary = rec.stop(9000);
    rec.markObservation("speaking", 9100);
    const payload = parseSessionInput(buildSessionPayload("Experiment", summary, rec.markers, rec.motionConnected));
    expect(payload.markers.map(m => m.kind)).toEqual(["possible_swallow_event", "manual"]);
    expect(rec.experiment.marks).toHaveLength(1);
    expect(rec.experiment.candidates).toEqual([{ id: 1, ms: 8050, audioRms: 0.03, imuActivity: 2 }]);
  });
});
