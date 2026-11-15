import type { MotionSample } from "./types";

type Sensor = "audio" | "motion";
type AudioHit = { ms: number; rms: number };
type MotionHit = { ms: number; tilt: number; turn: number };
export type FusionEvent = { ms: number; audioRms: number; imuActivity: number; gapMs: number };

function quantile(sorted: number[], fraction: number): number {
  const index = (sorted.length - 1) * fraction;
  const low = Math.floor(index);
  return sorted[low] + (sorted[Math.ceil(index)] - sorted[low]) * (index - low);
}

// Same quiet-period thresholds as SwallowEventDetector.calculate_threshold.
function threshold(values: number[], multiplier: number, floor: number) {
  const sorted = [...values].sort((a, b) => a - b);
  const median = quantile(sorted, 0.5);
  const deviations = sorted.map(value => Math.abs(value - median)).sort((a, b) => a - b);
  return Math.max(floor, quantile(sorted, 0.95) * multiplier, median + 6 * quantile(deviations, 0.5));
}

export class FusionDetector {
  private audio: number[] = [];
  private tilt: number[] = [];
  private turn: number[] = [];
  private start = { audio: Infinity, motion: Infinity };
  private latest = { audio: -Infinity, motion: -Infinity };
  private previous: MotionSample | null = null;
  private release = { audio: false, motion: false };
  private audioHit: AudioHit | null = null;
  private motionHit: MotionHit | null = null;
  private calibratedAt = Infinity;
  private lastEvent = -Infinity;
  private limits = { audio: 0, tilt: 0, turn: 0 };

  get calibrated() { return Number.isFinite(this.calibratedAt); }

  receiving(ms: number) {
    return ms - Math.min(this.latest.audio, this.latest.motion) <= 1000;
  }

  private get quietStart() { return Math.max(this.start.audio, this.start.motion) + 3000; }

  status(ms: number): string {
    const audio = ms - this.latest.audio <= 1000;
    const motion = ms - this.latest.motion <= 1000;
    if (!audio && !motion) return "Waiting for audio and movement";
    if (!audio) return "Waiting for audio";
    if (!motion) return "Waiting for movement";
    if (this.calibrated) return "Detector active";
    const quietMs = Math.min(this.latest.audio, this.latest.motion) - this.quietStart;
    if (quietMs < 0) return `Get ready · ${Math.ceil(-quietMs / 1000)} s`;
    if (quietMs < 5000) return `Calibrating (stay still) · ${Math.ceil((5000 - quietMs) / 1000)} s`;
    return "Calibrating · waiting for 20 samples per sensor";
  }

  private acceptTime(sensor: Sensor, ms: number): boolean {
    if (!Number.isFinite(ms) || ms < 0 || ms <= this.latest[sensor]) return false;
    if (Number.isFinite(this.latest[sensor]) && ms - this.latest[sensor] > 1000) {
      // A stopped stream or USB reconnect needs a fresh quiet period. In
      // particular, never compare an accelerometer sample across a dropout.
      this.audio = []; this.tilt = []; this.turn = [];
      this.start = { audio: Infinity, motion: Infinity };
      this.latest = { audio: -Infinity, motion: -Infinity };
      this.previous = null;
      this.audioHit = null; this.motionHit = null;
      this.release = { audio: false, motion: false };
      this.calibratedAt = Infinity;
    }
    this.start[sensor] = Math.min(this.start[sensor], ms);
    this.latest[sensor] = ms;
    return true;
  }

  private calibrate(ms: number) {
    const coverage = Math.min(this.latest.audio, this.latest.motion) - this.quietStart;
    if (coverage < 5000 || !this.receiving(ms) || this.audio.length < 20 || this.tilt.length < 20) return;
    this.limits = {
      audio: threshold(this.audio, 2.5, 0.0001),
      tilt: threshold(this.tilt, 3, 1e-6),
      turn: threshold(this.turn, 3, 1e-6),
    };
    this.calibratedAt = Math.max(this.latest.audio, this.latest.motion);
    this.audio = []; this.tilt = []; this.turn = [];
  }

  onAudio(ms: number, rms: number, frameStartMs = ms): FusionEvent | null {
    if (!Number.isFinite(rms) || rms < 0 || !this.acceptTime("audio", ms)) return null;
    if (!this.calibrated) {
      if (frameStartMs < this.quietStart) return null;
      if (this.audio.length >= 512) this.audio.shift();
      this.audio.push(rms);
      this.calibrate(ms);
    } else if (this.isHit("audio", ms, rms >= this.limits.audio)) {
      this.audioHit = { ms, rms };
      return this.detect();
    }
    return null;
  }

  onMotion(ms: number, sample: MotionSample): FusionEvent | null {
    const { ax, ay, az, gx, gy, gz } = sample;
    const previousMs = this.latest.motion;
    if (![ax, ay, az, gx, gy, gz].every(Number.isFinite) || !this.acceptTime("motion", ms)) return null;
    const previous = this.previous;
    this.previous = sample;
    if (!previous) return null;
    const tilt = Math.hypot(ax - previous.ax, ay - previous.ay, az - previous.az);
    const turn = Math.hypot(gx, gy, gz);
    if (!this.calibrated) {
      if (previousMs < this.quietStart) return null;
      if (this.tilt.length >= 1024) { this.tilt.shift(); this.turn.shift(); }
      this.tilt.push(tilt);
      this.turn.push(turn);
      this.calibrate(ms);
    } else if (this.isHit("motion", ms, tilt >= this.limits.tilt || turn >= this.limits.turn)) {
      this.motionHit = { ms, tilt, turn };
      return this.detect();
    }
    return null;
  }

  private isHit(sensor: Sensor, ms: number, active: boolean) {
    if (ms <= this.calibratedAt) return false;
    if (!active) { this.release[sensor] = false; return false; }
    if (ms - this.lastEvent < 1500) { this.release[sensor] = true; return false; }
    return !this.release[sensor];
  }

  private detect(): FusionEvent | null {
    if (!this.audioHit || !this.motionHit) return null;
    const gapMs = Math.abs(this.audioHit.ms - this.motionHit.ms);
    if (gapMs > 650) return null;
    const ms = Math.max(this.audioHit.ms, this.motionHit.ms);
    const event = { ms, gapMs, audioRms: this.audioHit.rms,
      imuActivity: Math.max(this.motionHit.tilt, this.motionHit.turn) };
    this.lastEvent = ms;
    this.release = { audio: true, motion: true };
    this.audioHit = null; this.motionHit = null;
    return event;
  }
}
