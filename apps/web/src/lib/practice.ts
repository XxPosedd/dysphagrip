import { strToU8, zipSync } from "fflate";

export const PRACTICE_ACTIONS = [
  { key: "1", category: "swallowing_saliva", title: "Saliva swallow" },
  { key: "2", category: "swallowing_water", title: "Water sip" },
  { key: "3", category: "speaking", title: "Speaking" },
  { key: "4", category: "head_movement", title: "Head movement" },
  { key: "5", category: "coughing", title: "Voluntary cough" },
] as const;

export type Category = typeof PRACTICE_ACTIONS[number]["category"];
type Channel = "audio" | "motion";
export type Pulse = Channel | "both";
type Mark = { id: number; ms: number; category: Category };
type Candidate = { id: number; ms: number; audioRms?: number; imuActivity?: number };

export interface ExperimentSession {
  startedAt: number;
  duration: number | null;
  marks: Mark[];
  candidates: Candidate[];
}

export interface PracticeSession extends ExperimentSession {
  recentPulses: { channel: Channel; ms: number }[];
  waiting: Record<Channel, number | null>;
}

export function beginPractice(startedAt: number): PracticeSession {
  return { startedAt, duration: null, marks: [], candidates: [], recentPulses: [], waiting: { audio: null, motion: null } };
}

// A pulse stands for a threshold crossing followed by release. Like the
// Python detector, consume both hits at coincidence and ignore hits in cooldown.
export function injectPulse(session: PracticeSession, pulse: Pulse, ms: number): PracticeSession {
  if (session.duration !== null) return session;
  const channels: Channel[] = pulse === "both" ? ["audio", "motion"] : [pulse];
  const recentPulses = session.recentPulses.filter(p => p.ms >= ms - 10_000);
  for (const channel of channels) recentPulses.push({ channel, ms });
  const lastCandidate = session.candidates.at(-1);
  if (lastCandidate && ms - lastCandidate.ms < 1500) return { ...session, recentPulses };

  const waiting = { ...session.waiting };
  for (const channel of channels) waiting[channel] = ms;
  if (waiting.audio === null || waiting.motion === null || Math.abs(waiting.audio - waiting.motion) > 650) {
    return { ...session, recentPulses, waiting };
  }
  const candidates = [...session.candidates, { id: session.candidates.length + 1, ms }];
  return { ...session, recentPulses, waiting: { audio: null, motion: null }, candidates };
}

export function addPracticeMark(session: PracticeSession, category: Category, ms: number): PracticeSession {
  if (session.duration !== null) return session;
  return { ...session, marks: [...session.marks, { id: session.marks.length + 1, category, ms }] };
}

function positive(mark: Mark) {
  return mark.category === "swallowing_saliva" || mark.category === "swallowing_water";
}

type Pair = { candidate: Candidate; mark: Mark; gap: number };

// Port of validation.match_events: smallest absolute gap first, then event
// and label insertion order. Each candidate and each label may be used once.
export function scorePractice(session: ExperimentSession) {
  const pairs: Pair[] = [];
  for (const candidate of session.candidates) {
    for (const mark of session.marks) {
      const gap = Math.abs(candidate.ms - mark.ms);
      if (gap <= 1500) pairs.push({ candidate, mark, gap });
    }
  }
  pairs.sort((a, b) => a.gap - b.gap || a.candidate.id - b.candidate.id || a.mark.id - b.mark.id);
  const usedCandidates = new Set<number>();
  const usedMarks = new Set<number>();
  const matches = pairs.filter(({ candidate, mark }) => {
    if (usedCandidates.has(candidate.id) || usedMarks.has(mark.id)) return false;
    usedCandidates.add(candidate.id);
    usedMarks.add(mark.id);
    return true;
  });

  const latencies = matches.filter(item => positive(item.mark))
    .map(({ candidate, mark }) => (candidate.ms - mark.ms) / 1000).sort((a, b) => a - b);
  const tp = latencies.length;
  const positiveLabels = session.marks.filter(positive).length;
  const precision = session.candidates.length ? tp / session.candidates.length : null;
  const recall = positiveLabels ? tp / positiveLabels : null;
  const f1 = precision === null || recall === null ? null : (precision + recall ? 2 * precision * recall / (precision + recall) : 0);
  const median = tp ? (latencies[Math.floor((tp - 1) / 2)] + latencies[Math.floor(tp / 2)]) / 2 : null;

  return {
    matches, tp, fp: session.candidates.length - tp, fn: positiveLabels - tp,
    positiveLabels, controlsWithoutDetection: session.marks.length - positiveLabels - (matches.length - tp),
    precision, recall, f1, meanLatency: tp ? latencies.reduce((a, b) => a + b, 0) / tp : null, medianLatency: median,
  };
}

function csv(rows: (string | number | null)[][]) {
  return strToU8(rows.map(row => row.map(value => {
    const cell = String(value ?? "");
    return /[",\r\n]/.test(cell) ? '"' + cell.replaceAll('"', '""') + '"' : cell;
  }).join(",")).join("\r\n") + "\r\n");
}

export function archiveExperiment(session: ExperimentSession, source: "device" | "simulation" | "file") {
  if (session.duration === null) throw new Error("Finish the session before exporting it.");
  const provenance = {
    simulation: ["practice-simulated", "SIMULATION. Synthetic pulses, no physical measurements. Coincidence and labelling practice."],
    device: ["experiment", "Experimental candidates from audio and movement coincidence."],
    file: ["experiment-playback", "File playback. Experimental candidates from audio and movement coincidence."],
  }[source];
  const result = scorePractice(session);
  const timestamp = (ms: number) => new Date(session.startedAt + ms).toISOString();
  const summary = {
    started_at: timestamp(0), tolerance_seconds: 1.5, duration_seconds: session.duration / 1000,
    prediction_count: session.candidates.length, label_count: session.marks.length,
    positive_label_count: result.positiveLabels, control_label_count: session.marks.length - result.positiveLabels,
    true_positives: result.tp, false_positives: result.fp, false_negatives: result.fn,
    precision: result.precision, recall: result.recall, f1: result.f1,
    false_positives_per_minute: session.duration > 0 ? result.fp * 60000 / session.duration : null,
    mean_latency_seconds: result.meanLatency, median_latency_seconds: result.medianLatency,
    controls_without_detection: result.controlsWithoutDetection,
    disclaimer: provenance[1],
  };
  const folder = provenance[0] + "-" + timestamp(0).replace(/[:.]/g, "-");
  return {
    filename: folder + ".zip",
    data: zipSync({
      [folder + "/ground_truth.csv"]: csv([["label_id", "timestamp", "monotonic", "category"],
        ...session.marks.map(m => [m.id, timestamp(m.ms), m.ms / 1000, m.category])]),
      [folder + "/predictions.csv"]: csv([["event_id", "timestamp", "monotonic", "audio_rms", "imu_activity"],
        ...session.candidates.map(c => [c.id, timestamp(c.ms), c.ms / 1000, c.audioRms ?? null, c.imuActivity ?? null])]),
      [folder + "/matches.csv"]: csv([["prediction_id", "label_id", "category", "latency_seconds", "kind"],
        ...result.matches.map(({ candidate, mark }) => [candidate.id, mark.id, mark.category, (candidate.ms - mark.ms) / 1000,
          positive(mark) ? "true_positive" : "false_positive_control"])]),
      [folder + "/summary.csv"]: csv([Object.keys(summary), Object.values(summary)]),
    }),
  };
}

export function downloadExperiment(session: ExperimentSession, source: "device" | "simulation" | "file") {
  const { filename, data } = archiveExperiment(session, source);
  const blob = new Blob([new Uint8Array(data)], { type: "application/zip" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
