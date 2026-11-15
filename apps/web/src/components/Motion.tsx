import { useEffect, useRef, useState } from "react";
import type { MotionListener } from "../hooks/useAudioService";
import { fitCanvas, readTokens, useDrawLoop } from "../lib/canvas";
import type { MotionFrame, MotionSample, MotionStatus, SerialPortInfo } from "../lib/types";
import { Card, Chip } from "./Panels";

const WINDOW_MS = 5000;
const AXES = ["x", "y", "z"] as const;
const TOKENS = ["grid", "text-muted", "series-1", "series-2", "series-3"] as const;

/** Two small scrolling charts (acceleration in g, angular rate in °/s), X/Y/Z in categorical slots 1-3. */
function MotionTraces({ subscribe, live }: { subscribe: (fn: MotionListener) => () => void; live: boolean }) {
  const accel = useRef<HTMLCanvasElement>(null);
  const gyro = useRef<HTMLCanvasElement>(null);
  const buf = useRef<MotionSample[]>([]);

  const drawOne = (c: HTMLCanvasElement | null, keys: readonly ["ax", "ay", "az"] | readonly ["gx", "gy", "gz"], minRange: number) => {
    if (!c) return;
    fitCanvas(c);
    const ctx = c.getContext("2d")!;
    const t = readTokens(c, TOKENS);
    const W = c.width, H = c.height, dpr = window.devicePixelRatio || 1;
    ctx.clearRect(0, 0, W, H);
    ctx.strokeStyle = t.grid;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, Math.round(H / 2) + 0.5); ctx.lineTo(W, Math.round(H / 2) + 0.5); ctx.stroke();
    const s = buf.current;
    if (s.length < 2) return;
    const tEnd = s[s.length - 1].t_unix_ms, tStart = tEnd - WINDOW_MS;
    // Gravity-free view for acceleration: subtract each axis' window mean so small movements are visible.
    const mean = keys.map((k) => s.reduce((a, x) => a + x[k], 0) / s.length);
    let range = minRange;
    for (const x of s) keys.forEach((k, i) => (range = Math.max(range, Math.abs(x[k] - (keys[0] === "ax" ? mean[i] : 0)))));
    const y = (v: number) => H / 2 - (v / range) * (H / 2 - 3 * dpr);
    keys.forEach((k, i) => {
      ctx.strokeStyle = t[(["series-1", "series-2", "series-3"] as const)[i]];
      ctx.lineWidth = 1.5 * dpr;
      ctx.lineJoin = "round";
      ctx.beginPath();
      s.forEach((x, j) => {
        const px = ((x.t_unix_ms - tStart) / WINDOW_MS) * W;
        const py = y(x[k] - (keys[0] === "ax" ? mean[i] : 0));
        if (j) ctx.lineTo(px, py); else ctx.moveTo(px, py);
      });
      ctx.stroke();
    });
    ctx.fillStyle = t["text-muted"];
    ctx.font = `${10 * dpr}px ui-sans-serif, system-ui, sans-serif`;
    ctx.fillText(`±${range.toFixed(keys[0] === "ax" ? 3 : 1)}${keys[0] === "ax" ? " g (mean removed)" : " °/s"}`, 4 * dpr, 11 * dpr);
  };

  const markDirty = useDrawLoop(() => {
    drawOne(accel.current, ["ax", "ay", "az"] as const, 0.02);
    drawOne(gyro.current, ["gx", "gy", "gz"] as const, 5);
  });

  useEffect(() => subscribe((f) => {
    buf.current.push(...f.samples);
    const cutoff = f.samples[f.samples.length - 1].t_unix_ms - WINDOW_MS;
    let i = 0;
    while (i < buf.current.length && buf.current[i].t_unix_ms < cutoff) i++;
    if (i) buf.current.splice(0, i);
    markDirty();
  }), [subscribe, markDirty]);

  useEffect(() => { if (!live) { buf.current = []; markDirty(); } }, [live, markDirty]);

  return (
    <div className="motion-traces">
      <div><span className="muted small">Acceleration</span><canvas ref={accel} className="canvas-motion" role="img" aria-label="Acceleration X Y Z, last 5 seconds" /></div>
      <div><span className="muted small">Angular rate</span><canvas ref={gyro} className="canvas-motion" role="img" aria-label="Gyroscope X Y Z, last 5 seconds" /></div>
      <div className="legend">
        {AXES.map((a, i) => <span key={a}><i className="sw line" style={{ background: `var(--series-${i + 1})` }} />{a.toUpperCase()}</span>)}
      </div>
    </div>
  );
}

export function MotionPanel({ status, latest, ports, error, subscribe, onStart, onStop, onRefreshPorts, serviceOnline }: {
  status: MotionStatus | null; latest: MotionFrame | null; ports: SerialPortInfo[]; error: string | null;
  subscribe: (fn: MotionListener) => () => void; onStart: (source: string) => void; onStop: () => void;
  onRefreshPorts: () => void; serviceOnline: boolean;
}) {
  const [choice, setChoice] = useState("auto");
  const [tcp, setTcp] = useState("tcp://");
  const running = status?.running ?? false;
  const receiving = status?.receiving ?? false;
  const sample = latest?.samples[latest.samples.length - 1];
  const f = latest?.features;

  const chip = !running ? <Chip tone="neutral">Not connected</Chip>
    : receiving ? <Chip tone="good">Live</Chip>
    : status?.connected ? <Chip tone="warning">Connected, no data</Chip>
    : <Chip tone="critical">Connecting…</Chip>;

  const metric = (label: string, value: number | undefined, unit: string, digits: number, i: number) => (
    <div className="metric" key={label}>
      <span><i className="sw line" style={{ background: `var(--series-${i + 1})` }} />{label}</span>
      <strong className="tabular">{value === undefined || !receiving ? "—" : `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`} <small>{unit}</small></strong>
    </div>
  );

  return (
    <Card title="Movement · MPU-6050" aside={chip}>
      <div className="row motion-controls">
        <select value={choice} disabled={running || !serviceOnline} onChange={(e) => setChoice(e.target.value)} aria-label="Motion source">
          <option value="auto">Auto-detect Arduino (USB)</option>
          {ports.map((p) => <option key={p.device} value={`serial:${p.device}`}>{p.device}{p.likely_arduino ? " ★ Arduino" : ""} · {p.description}</option>)}
          <option value="tcp">Network relay (TCP)…</option>
        </select>
        {choice === "tcp" && !running && (
          <input className="text-input" value={tcp} onChange={(e) => setTcp(e.target.value)} placeholder="tcp://board-ip:7070" aria-label="Relay address" />
        )}
        {running
          ? <button className="btn btn-sm btn-ghost" onClick={onStop}>Disconnect</button>
          : <button className="btn btn-sm" disabled={!serviceOnline} onClick={() => onStart(choice === "tcp" ? tcp : choice)}>Connect</button>}
        <button className="btn btn-sm btn-ghost" onClick={onRefreshPorts} disabled={!serviceOnline} aria-label="Refresh serial ports" title="Refresh serial ports">↻</button>
      </div>
      {error && <p className="error">{error}</p>}
      {running && status?.device_errors?.length ? <p className="error">Sensor: {status.device_errors[status.device_errors.length - 1]}</p> : null}
      {running && !receiving && status?.last_error && <p className="error">{status.last_error}</p>}
      {!running && <p className="muted small">Connect the Arduino UNO Q running the DysphaGrip firmware. Motion measures movement of
        the sensor mount, used to flag moments when audio is likely affected by movement or handling.</p>}

      <h3 className="sub">Acceleration</h3>
      <div className="motion-axes">{(["ax", "ay", "az"] as const).map((k, i) => metric(`Accel ${"XYZ"[i]}`, sample?.[k], "g", 3, i))}</div>
      <h3 className="sub">Gyroscope</h3>
      <div className="motion-axes">{(["gx", "gy", "gz"] as const).map((k, i) => metric(`Gyro ${"XYZ"[i]}`, sample?.[k], "°/s", 1, i))}</div>

      {running && (
        <>
          <MotionTraces subscribe={subscribe} live={receiving} />
          <div className="band motion-score">
            <span>Movement</span>
            <div className="bar"><div style={{ width: `${Math.min(100, (f?.movement_score ?? 0) * 50)}%`,
              background: f?.interference ? "var(--status-warning)" : "var(--series-audio)" }} /></div>
            <strong className="tabular">{(f?.movement_score ?? 0).toFixed(2)}</strong>
          </div>
          {f?.interference && <p className="notice-inline"><Chip tone="warning">Movement interference</Chip> audio from this moment may be affected</p>}
          <p className="muted small tabular">
            {status?.device?.device ?? "device ?"} {status?.device?.whoami ? `(WHO_AM_I ${status.device.whoami})` : ""} ·{" "}
            {status?.device?.rate_hz ?? "?"} Hz · {status?.source} ·{" "}
            {status?.sync?.offset_ms != null ? "clock synced to this computer" : "syncing clock…"}
            {status?.sync?.jitter_p95_ms != null ? ` · arrival jitter p95 ${status.sync.jitter_p95_ms} ms` : ""}
            {status?.sync?.drift_ppm != null ? ` · drift ${status.sync.drift_ppm} ppm` : ""}
            {status?.seq_gaps ? ` · ${status.seq_gaps} samples lost` : ""}
          </p>
        </>
      )}
    </Card>
  );
}
