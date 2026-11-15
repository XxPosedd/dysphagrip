import type { QualityLabel } from "./types";

/**
 * Turns the per-frame boolean `activity` flag into experimental "audio activity" segments.
 *
 * A segment opens after activity has been continuously present for `minOnMs`, and closes
 * once activity has been absent for `minOffMs` (short dropouts are bridged). Segments are
 * labelled "audio activity (experimental)". They mean "energy above the noise floor",
 * NOT "a swallow".
 */
export interface Segment {
  start_ms: number;
  end_ms: number;
}

export class ActivitySegmenter {
  private onSince: number | null = null;   // first active frame of a candidate run
  private open: Segment | null = null;     // currently open, confirmed segment
  private lastActive = 0;

  constructor(private minOnMs = 150, private minOffMs = 200, private maxMs = 10_000) {}

  /** Feed one frame. Returns a completed segment when one closes. */
  push(t_ms: number, active: boolean): Segment | null {
    if (active) {
      this.lastActive = t_ms;
      if (this.open) {
        if (t_ms - this.open.start_ms >= this.maxMs) return this.close(t_ms);
        return null;
      }
      if (this.onSince === null) this.onSince = t_ms;
      if (t_ms - this.onSince >= this.minOnMs) this.open = { start_ms: this.onSince, end_ms: t_ms };
      return null;
    }
    if (!this.open) {
      this.onSince = null;
      return null;
    }
    if (t_ms - this.lastActive >= this.minOffMs) return this.close(this.lastActive);
    return null;
  }

  /** Segment currently in progress (for live drawing). */
  get current(): Segment | null {
    return this.open ? { start_ms: this.open.start_ms, end_ms: this.lastActive } : null;
  }

  flush(t_ms: number): Segment | null {
    return this.open ? this.close(Math.min(t_ms, this.lastActive)) : null;
  }

  private close(end: number): Segment {
    const seg = { start_ms: this.open!.start_ms, end_ms: end };
    this.open = null;
    this.onSince = null;
    return seg;
  }
}

/**
 * Debounces quality labels so one noisy frame doesn't flicker the UI or spam markers.
 * A new label is accepted only after it persists for `holdMs`.
 */
export class QualityDebouncer {
  private stable: QualityLabel | null = null;
  private candidate: QualityLabel | null = null;
  private since = 0;

  constructor(private holdMs = 1000) {}

  /** Returns the new stable label when it changes, otherwise null. */
  push(t_ms: number, label: QualityLabel): QualityLabel | null {
    if (this.stable === null) {
      this.stable = label;
      return label;
    }
    if (label === this.stable) {
      this.candidate = null;
      return null;
    }
    if (label !== this.candidate) {
      this.candidate = label;
      this.since = t_ms;
      return null;
    }
    if (t_ms - this.since >= this.holdMs) {
      this.stable = label;
      this.candidate = null;
      return label;
    }
    return null;
  }

  get label(): QualityLabel | null {
    return this.stable;
  }
}
