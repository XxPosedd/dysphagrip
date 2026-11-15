import { describe, expect, it } from "vitest";
import { parseSessionInput } from "../../../../../server/src/validation";
import { SessionRecorder, buildSessionPayload } from "../session";
import { parseAudioMessage } from "../stream";
import type { MotionFrame } from "../types";

const T0 = 1_800_000_000_000;

function mframe(t_ms: number, interference: boolean, score = interference ? 1.4 : 0.1): MotionFrame {
  const samples = [0, 10, 20, 30, 40].map((d) => ({ t_unix_ms: T0 + t_ms - 40 + d, ax: 0, ay: 0, az: 1, gx: 0, gy: 0, gz: 0 }));
  return { type: "motion_frame", samples, features: { movement_score: score, interference } };
}

describe("motion messages", () => {
  it("parses motion frames and motion status, rejects malformed ones", () => {
    const f = mframe(100, false);
    expect(parseAudioMessage(JSON.stringify(f))?.type).toBe("motion_frame");
    expect(parseAudioMessage(JSON.stringify({ type: "motion_status", running: true, receiving: false }))?.type).toBe("motion_status");
    expect(parseAudioMessage(JSON.stringify({ type: "motion_frame", samples: [{ t_unix_ms: "x" }], features: {} }))).toBeNull();
    expect(parseAudioMessage(JSON.stringify({ type: "motion_frame", samples: [] }))).toBeNull();
    expect(parseAudioMessage(JSON.stringify({ type: "motion_status" }))).toBeNull();
  });
});

describe("SessionRecorder motion", () => {
  it("records the motion lane, turns interference into markers and announces once per episode", () => {
    const rec = new SessionRecorder(T0, null);
    let starts = 0;
    rec.onMovementStart.push(() => starts++);
    for (let t = 50; t <= 1000; t += 50) rec.ingestMotion(mframe(t, t >= 400 && t <= 700));
    expect(rec.motionConnected).toBe(true);
    expect(rec.motionPoints).toHaveLength(20);
    expect(starts).toBe(1);
    const m = rec.markers.filter((x) => x.kind === "movement_interference");
    expect(m).toHaveLength(1);
    expect(m[0].label).toBe("Movement interference");
    expect(m[0].t_ms).toBe(360);              // first sample of the first interfering frame
    expect(m[0].duration_ms).toBe(390);       // closed by the first calm frame at 750 ms
  });

  it("closes an open episode on stop and the payload passes server validation with motion_connected", () => {
    const rec = new SessionRecorder(T0, null);
    rec.ingestMotion(mframe(100, false));
    rec.ingestMotion(mframe(200, true));
    expect(rec.currentInterference).toEqual({ start_ms: 160, end_ms: 200 });
    const summary = rec.stop(T0 + 500);
    const payload = buildSessionPayload("Motion test", summary, rec.markers, rec.motionConnected);
    const parsed = parseSessionInput(JSON.parse(JSON.stringify(payload)));
    expect(parsed.motion_connected).toBe(true);
    expect(parsed.markers.map((x) => x.kind)).toEqual(["movement_interference"]);
    expect(parsed.markers[0]).toMatchObject({ t_ms: 160, duration_ms: 340 });
  });

  it("ignores motion before the session and after stop", () => {
    const rec = new SessionRecorder(T0, null);
    rec.ingestMotion(mframe(-500, true));
    expect(rec.motionPoints).toHaveLength(0);
    rec.stop(T0 + 100);
    rec.ingestMotion(mframe(200, true));
    expect(rec.motionPoints).toHaveLength(0);
    expect(rec.motionConnected).toBe(false);
  });
});
