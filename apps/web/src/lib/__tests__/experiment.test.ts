import { describe, expect, it } from "vitest";
import { openExperiment, parseTable, readMotion } from "../experiment";

function sessionFile(path: string, contents: string): File {
  return {
    webkitRelativePath: "experimento_01/" + path,
    name: path.split("/").at(-1),
    text: () => Promise.resolve(contents),
  } as File;
}

const header = "label_id,timestamp,monotonic,category\r\n";
const labels = sessionFile("ground_truth.csv", header + "12,2026-11-15T00:00:00-08:00,25.555000,head_movement\r\n");

describe("importing Proyecto 2 experiment folders", () => {
  it("keeps capture paths scoped to the session and distinguishes missing reports from empty ones", async () => {
    const audio = sessionFile("captures/mark_0012/audio.wav", "");
    const session = await openExperiment([
      labels, audio, sessionFile("matches.csv", "prediction_id,label_id,category,latency_seconds,kind\r\n"),
    ]);
    expect(session.name).toBe("experimento_01");
    expect(session.labels[0]).toMatchObject({ label_id: "12", category: "head_movement" });
    expect(session.files.get("captures/mark_0012/audio.wav")).toBe(audio);
    expect(session.matches).toEqual([]);
    expect(session.predictions).toBeNull();
    expect(session.summary).toBeNull();
  });
  it("opens an empty session and rejects the experiments parent folder", async () => {
    expect((await openExperiment([sessionFile("ground_truth.csv", header)])).labels).toEqual([]);
    await expect(openExperiment([sessionFile("unrelated/ground_truth.csv", header)])).rejects.toThrow("single session");
  });
  it("reads quoted fields and refuses mismatched columns", () => {
    expect(parseTable('\uFEFFkey,note\r\n1,"a, ""b"""\r\n', ["key", "note"], "test.csv"))
      .toEqual([{ key: "1", note: 'a, "b"' }]);
    expect(() => parseTable("id,other\n1,2,3", ["id"], "test.csv")).toThrow("test.csv");
  });
  it("reads all six motion axes and keeps signed time offsets", () => {
    const columns = "seconds_from_mark,monotonic,tilt_x,tilt_y,tilt_z,turn_x,turn_y,turn_z\n";
    expect(readMotion(columns + "-0.002,1234.0,1.0,0,0.2,-3.2,4.5,0")).toEqual([
      { seconds: -0.002, axes: [1, 0, 0.2, -3.2, 4.5, 0] },
    ]);
    expect(() => readMotion(columns + "0,1,2,3,4,5,,7")).toThrow("invalid");
  });
});
