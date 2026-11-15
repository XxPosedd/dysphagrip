import { useId } from "react";
import type { MonitorStatus } from "../lib/monitor";
import { Card } from "./Panels";

interface TraceProps {
  title: string;
  unit: string;
  data: number[];
  times?: number[];
  duration?: number;
  end?: number;
  signed?: boolean;
  color: string;
}

function Trace({ title, unit, data, times, duration = 5, end = 0, signed = false, color }: TraceProps) {
  const grid = useId().replaceAll(":", "");
  const samples = data.map((value, i) => ({
    t: times ? times[i] : end - duration + duration * i / Math.max(1, data.length - 1), value,
  })).filter(({ t, value }) => Number.isFinite(t) && Number.isFinite(value) && t >= -5 && t <= 0);
  const peak = samples.reduce((max, x) => Math.max(max, Math.abs(x.value)), 0);
  const range = peak > 0 ? peak : 1;
  const y = (value: number) => signed ? 50 - 46 * value / range : 96 - 92 * value / range;
  const points = samples.map(({ t, value }) => `${(t + 5) * 160},${y(value)}`).join(" ");
  return <figure className="monitor-plot">
    <figcaption><span>{title}</span><span>{unit}</span></figcaption>
    <div className="trace-frame">
      <svg viewBox="0 0 800 100" preserveAspectRatio="none" role="img" aria-label={title + ", last five seconds"}>
        <defs><pattern id={grid} width="80" height="25" patternUnits="userSpaceOnUse">
          <path d="M 80 0 H 0 V 25" fill="none" stroke="var(--border)" strokeWidth="1" />
        </pattern></defs>
        <rect width="800" height="100" fill={`url(#${grid})`}/>
        {samples.length > 0 && <polyline points={points} fill="none" stroke={color} strokeWidth="1.6" vectorEffect="non-scaling-stroke" />}
      </svg>
      {samples.length === 0 ? <span className="trace-empty">Waiting for signal</span> :
        <span className="trace-scale">{range.toLocaleString("en", { maximumSignificantDigits: 3 })} {unit}</span>}
    </div>
  </figure>;
}

export default function MonitorSignals({ status }: { status: MonitorStatus | null }) {
  return <Card title="Live signals" aside={<span className="muted small">5-second window</span>}>
    <div className="monitor-traces">
      <Trace title="Contact microphone" unit="amplitude" data={status?.hardware.audio ? status.audio_waveform : []}
        duration={status?.audio_span_seconds ?? Math.min(5, status?.elapsed_seconds ?? 5)}
        end={status?.audio_end_offset_seconds} signed color="var(--series-audio)" />
      <Trace title="Acceleration magnitude" unit="g" data={status?.hardware.imu ? status.motion.accel : []}
        times={status?.motion.time} color="var(--series-2)" />
      <Trace title="Angular speed" unit="°/s" data={status?.hardware.imu ? status.motion.gyro : []}
        times={status?.motion.time} color="var(--series-3)" />
    </div>
    <div className="trace-time"><span>−5 s</span><span>Now</span></div>
  </Card>;
}
