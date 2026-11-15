/** Tables and capture paths written by ExperimentLog and LabelCapture in Proyecto 2. */
export type CsvRow = Record<string, string>;

export function parseTable(text: string, required: string[], source: string): CsvRow[] {
  const lines: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const csv = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  for (let i = 0; i < csv.length; i++) {
    const char = csv[i];
    if (char === '"') {
      if (quoted && csv[i + 1] === '"') { field += '"'; i++; }
      else quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(field);
      field = "";
    } else if (char === "\n" && !quoted) {
      if (row.length || field) lines.push([...row, field]);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (row.length || field) lines.push([...row, field]);
  const headers = lines.shift() ?? [];
  if (quoted || new Set(headers).size !== headers.length ||
      !required.every((key) => headers.includes(key)) ||
      lines.some((r) => r.length !== headers.length)) {
    throw new Error(`Check the format of ${source}: expected the coincidence-experiment CSV.`);
  }
  return lines.map((values) => Object.fromEntries(headers.map((h, i) => [h, values[i]])));
}

export interface Experiment {
  name: string;
  labels: CsvRow[];
  predictions: CsvRow[] | null;
  matches: CsvRow[] | null;
  summary: CsvRow | null;
  files: Map<string, File>;
}

export async function openExperiment(selection: File[]): Promise<Experiment> {
  const files = new Map<string, File>();
  for (const file of selection) {
    const full = file.webkitRelativePath || file.name;
    files.set(full.slice(full.indexOf("/") + 1), file);
  }
  if (!files.has("ground_truth.csv")) {
    throw new Error("Choose the folder of a single session (the one containing ground_truth.csv).");
  }
  async function table(name: string, fields: string[]) {
    const file = files.get(name);
    return file ? parseTable(await file.text(), fields, name) : null;
  }
  const [labels, predictions, matches, summary] = await Promise.all([
    table("ground_truth.csv", ["label_id", "timestamp", "category"]),
    table("predictions.csv", ["event_id", "timestamp", "audio_rms", "imu_activity"]),
    table("matches.csv", ["prediction_id", "label_id", "latency_seconds", "kind"]),
    table("summary.csv", ["duration_seconds", "true_positives", "false_positives", "false_negatives"]),
  ]);
  const ids = labels!.map((label) => label.label_id);
  if (ids.some((id) => !/^\d+$/.test(id)) || new Set(ids).size !== ids.length) {
    throw new Error("ground_truth.csv contains invalid or duplicate mark IDs.");
  }
  return {
    labels: labels!, predictions, matches, summary: summary?.[0] ?? null, files,
    name: selection[0]?.webkitRelativePath.split("/")[0] || "Imported session",
  };
}

export const MOTION_AXES = ["tilt_x", "tilt_y", "tilt_z", "turn_x", "turn_y", "turn_z"] as const;

export function readMotion(csv: string) {
  return parseTable(csv, ["seconds_from_mark", ...MOTION_AXES], "motion.csv").map((row) => {
    const raw = [row.seconds_from_mark, ...MOTION_AXES.map((axis) => row[axis])];
    if (raw.some((v) => !v.trim() || !Number.isFinite(Number(v)))) {
      throw new Error("motion.csv contains an invalid movement reading.");
    }
    const [seconds, ...axes] = raw.map(Number);
    return { seconds, axes };
  });
}
export type MotionSample = ReturnType<typeof readMotion>[number];
