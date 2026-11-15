import { useEffect, useRef, useState } from "react";
import type { AudioFrame, MotionFrame } from "../lib/types";

type Features = { level: number; spectrum: number; motion?: number };
type Status = "waiting" | "learning" | "blocked" | "flagged" | "within";
type Reading = { status: Status; message: string; reasons: string[] };
const BASELINE_SIZE = 48;
const MIN_BASELINE = 20;
const OUTLIER_Z = 3.5;

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function compare(value: number, previous: number[], label: string) {
  const center = median(previous);
  const mad = median(previous.map((x) => Math.abs(x - center)));
  const scale = Math.max(1.4826 * mad, Math.abs(center) * 0.02, 0.02);
  const z = (value - center) / scale;
  return { z, reason: `${label} ${z > 0 ? "higher" : "lower"} than recent range (${Math.abs(z).toFixed(1)} robust deviations)` };
}

export function AnomalyExplanation({ frame, motion }: { frame: AudioFrame | null; motion: MotionFrame | null }) {
  const history = useRef<Features[]>([]);
  const lastSequence = useRef<number | null>(null);
  const [reading, setReading] = useState<Reading>({ status: "waiting", message: "Waiting for sensor data.", reasons: [] });

  useEffect(() => {
    if (!frame || frame.seq === lastSequence.current) return;
    lastSequence.current = frame.seq;

    if (frame.quality.label !== "ok") {
      setReading({ status: "blocked", message: `Not scored: the audio service reports ${frame.quality.label.replaceAll("_", " ")}. Poor signal quality can itself look unusual.`, reasons: [] });
      return;
    }
    if (motion?.features.interference) {
      setReading({ status: "blocked", message: "Not scored: the motion service detected movement interference, which can distort neck-sensor readings.", reasons: [] });
      return;
    }

    const current: Features = {
      level: frame.features.rms_dbfs,
      spectrum: frame.features.spectral_centroid_hz,
      ...(typeof motion?.features.movement_score === "number" ? { motion: motion.features.movement_score } : {}),
    };
    const prior = history.current;
    if (prior.length < MIN_BASELINE) {
      history.current = [...prior, current].slice(-BASELINE_SIZE);
      setReading({ status: "learning", message: `Building a recording-specific reference (${history.current.length}/${MIN_BASELINE} usable windows).`, reasons: [] });
      return;
    }

    const comparisons = [
      compare(current.level, prior.map((x) => x.level), "Microphone level"),
      compare(current.spectrum, prior.map((x) => x.spectrum), "Vibration spectrum center"),
    ];
    if (current.motion !== undefined) {
      const motionPrior = prior.flatMap((x) => x.motion === undefined ? [] : [x.motion]);
      if (motionPrior.length >= MIN_BASELINE) comparisons.push(compare(current.motion, motionPrior, "Neck movement score"));
    }
    const outliers = comparisons.filter((x) => Math.abs(x.z) >= OUTLIER_Z);
    history.current = [...prior, current].slice(-BASELINE_SIZE);
    setReading(outliers.length
      ? { status: "flagged", message: "Flagged because this window differs from the recent recording baseline on the measures below.", reasons: outliers.map((x) => x.reason) }
      : { status: "within", message: "No large deviation was found in the measured features; this window is within the recent recording baseline.", reasons: [] });
  }, [frame, motion]);

  const tone = reading.status === "flagged" ? "warning" : reading.status === "within" ? "good" : "neutral";
  const title = reading.status === "flagged" ? "Unusual signal" : reading.status === "within" ? "Within recording range" : reading.status === "blocked" ? "Cannot assess this window" : reading.status === "learning" ? "Learning recording range" : "Waiting for data";
  return <section className={`anomaly-result anomaly-${reading.status}`} aria-live="polite">
    <div className="anomaly-result-head"><span className={`chip chip-${tone}`}><span className="chip-icon" aria-hidden>{reading.status === "flagged" ? "!" : reading.status === "within" ? "✓" : "○"}</span>{title}</span></div>
    <p>{reading.message}</p>
    {reading.reasons.length > 0 && <ul>{reading.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>}
    {reading.status === "within" && <p className="muted small">“Within range” only means similar to recent windows in this recording. It does not mean the swallow is healthy or safe.</p>}
    {reading.status === "flagged" && <p className="muted small">A flag means signal difference, not dysphagia. Sensor contact, speech, cough, head movement, recording noise, or swallow-to-swallow variation can cause it.</p>}
    <p className="muted small">This is an experimental transparent outlier check on microphone level, spectrum, and available motion features—not the trained Python model or a clinical classifier. Research has reported associations between neck-sensor features and swallow kinematics, but these signals alone cannot explain the cause. <a href="https://pubmed.ncbi.nlm.nih.gov/30071198/" target="_blank" rel="noreferrer">Study of signal features and swallow events</a>.</p>
  </section>;
}
