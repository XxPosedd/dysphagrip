import { useEffect, useRef } from "react";
import type { ImuSampleMsg } from "../lib/monitorTypes";
import { fitCanvas, readTokens, useDrawLoop } from "../lib/canvas";

const TOKENS = ["surface-2", "grid", "series-1", "series-2", "series-3", "text-muted", "accent"] as const;

export function MotionChart({ samples, live }: { samples: ImuSampleMsg[]; live: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const data = useRef(samples);
  data.current = samples;

  const markDirty = useDrawLoop(() => {
    const c = canvas.current;
    if (!c) return;
    fitCanvas(c);
    const ctx = c.getContext("2d")!;
    const t = readTokens(c, TOKENS);
    const W = c.width, H = c.height;
    ctx.clearRect(0, 0, W, H);

    ctx.strokeStyle = t.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const y of [H * 0.25, H * 0.5, H * 0.75]) {
      ctx.moveTo(0, Math.round(y) + 0.5);
      ctx.lineTo(W, Math.round(y) + 0.5);
    }
    ctx.stroke();

    const pts = data.current;
    if (pts.length < 2) return;

    const mags = pts.map((p) => p.accel_mag);
    let lo = Math.min(...mags), hi = Math.max(...mags);
    if (hi - lo < 0.05) { lo -= 0.05; hi += 0.05; }

    const draw = (color: string, getter: (p: ImuSampleMsg) => number, scaleLo: number, scaleHi: number) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      pts.forEach((p, i) => {
        const x = (i / (pts.length - 1)) * W;
        const v = getter(p);
        const y = H - ((v - scaleLo) / (scaleHi - scaleLo)) * (H - 8) - 4;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
    };

    draw(t["series-1"], (p) => p.ax, -2, 2);
    draw(t["series-2"], (p) => p.ay, -2, 2);
    draw(t["series-3"], (p) => p.az, -0.5, 2.5);
    draw(t.accent, (p) => p.accel_mag, lo, hi);
  });

  useEffect(() => { markDirty(); }, [samples, markDirty]);

  return (
    <div className="plot">
      <div className="plot-head">
        <h3>Biomechanical activity · MPU-6050</h3>
        <span className="muted small">{live ? "Live" : "Idle"} · accel X/Y/Z + |a|</span>
      </div>
      <canvas ref={canvas} className="plot-canvas motion-canvas" />
      <div className="legend muted small">
        <span><i className="sw" style={{ background: "var(--series-1)" }} /> Ax</span>
        <span><i className="sw" style={{ background: "var(--series-2)" }} /> Ay</span>
        <span><i className="sw" style={{ background: "var(--series-3)" }} /> Az</span>
        <span><i className="sw" style={{ background: "var(--accent)" }} /> |a|</span>
      </div>
    </div>
  );
}
