import { describe, expect, it } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import { addPracticeMark, archiveExperiment, beginPractice, injectPulse, scorePractice } from "../practice";

describe("pulsos simulados", () => {
  it("requires one crossing on each channel within 650 ms and enforces cooldown", () => {
    let s = beginPractice(0);
    s = injectPulse(s, "audio", 0);
    s = injectPulse(s, "motion", 651);
    expect(s.candidates).toHaveLength(0);
    s = injectPulse(s, "audio", 1301);
    expect(s.candidates.map(e => e.ms)).toEqual([1301]);
    s = injectPulse(s, "both", 2800);
    s = injectPulse(s, "motion", 2801);
    expect(s.candidates).toHaveLength(1);
    s = injectPulse(s, "audio", 2802);
    expect(s.candidates.map(e => e.ms)).toEqual([1301, 2802]);
    const stopped = { ...s, duration: 3000 };
    expect(injectPulse(stopped, "both", 7000)).toBe(stopped);
    expect(addPracticeMark(stopped, "coughing", 7000)).toBe(stopped);
  });

  it("matches nearest labels one-to-one before scoring controls and missed labels", () => {
    let s = beginPractice(0);
    s = injectPulse(s, "both", 1000);
    s = injectPulse(s, "both", 2500);
    s = injectPulse(s, "both", 5000);
    s = addPracticeMark(s, "speaking", 1100);
    s = addPracticeMark(s, "swallowing_saliva", 1010);
    s = addPracticeMark(s, "swallowing_water", 9000);
    expect(scorePractice(s)).toMatchObject({
      tp: 1, fp: 2, fn: 1, precision: 1 / 3, recall: 0.5, meanLatency: -0.01, controlsWithoutDetection: 0,
      matches: [{ candidate: { id: 1 }, mark: { id: 2 } }, { candidate: { id: 2 }, mark: { id: 1 } }],
    });
  });

  it("produces a four-CSV experiment directory with provenance and no invented sensor readings", () => {
    let s = beginPractice(Date.UTC(2026, 0, 1));
    s = injectPulse(s, "both", 100);
    s = addPracticeMark(s, "head_movement", 110);
    const file = archiveExperiment({ ...s, duration: 2000 }, "simulation");
    const folder = file.filename.slice(0, -4);
    const rows = unzipSync(file.data);
    expect(Object.keys(rows)).toHaveLength(4);
    expect(strFromU8(rows[folder + "/summary.csv"])).toContain("SIMULACIÓN");
    expect(strFromU8(rows[folder + "/ground_truth.csv"])).toContain("0.11,head_movement");
    expect(strFromU8(rows[folder + "/matches.csv"])).toContain("1,1,head_movement,-0.01,false_positive_control");
    expect(strFromU8(rows[folder + "/predictions.csv"])).toContain("0.1,,\r\n");
  });

  it("leaves undefined metrics empty and retains real measurements for device sessions", () => {
    const s = { ...beginPractice(0), duration: 50 };
    expect(scorePractice(s)).toMatchObject({ precision: null, recall: null, f1: null });
    const file = archiveExperiment({ ...s, candidates: [{ id: 1, ms: 10, audioRms: 0.012, imuActivity: 1.5 }] }, "device");
    const files = unzipSync(file.data);
    expect(strFromU8(files[file.filename.slice(0, -4) + "/predictions.csv"])).toContain("0.01,0.012,1.5");
  });
});
