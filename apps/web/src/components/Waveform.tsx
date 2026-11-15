import { useEffect, useRef } from "react";
import type { FrameListener } from "../hooks/useAudioService";
import { fitCanvas, readTokens, useDrawLoop } from "../lib/canvas";

const WINDOW_FRAMES = 100; // ~5 s at 20 frames/s
const TOKENS = ["surface-2", "grid", "series-audio", "text-muted"] as const;

export function Waveform({ subscribe, live }: { subscribe: (fn: FrameListener) => () => void; live: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const history = useRef<{ min: number[]; max: number[] }[]>([]);
  const scaleLabel = useRef<HTMLSpanElement>(null);

  const markDirty = useDrawLoop(() => {
    const c = canvas.current;
    if (!c) return;
    fitCanvas(c);
    const ctx = c.getContext("2d")!;
    const t = readTokens(c, TOKENS);
    const W = c.width, H = c.height, mid = H / 2;
    ctx.clearRect(0, 0, W, H);

    // Recessive grid: centre line + quarter lines
    ctx.strokeStyle = t.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const y of [H * 0.25, mid, H * 0.75]) { ctx.moveTo(0, Math.round(y) + 0.5); ctx.lineTo(W, Math.round(y) + 0.5); }
    ctx.stroke();

    const frames = history.current;
    if (scaleLabel.current) scaleLabel.current.textContent = "";
    if (!frames.length) return;
    const pointsPer = frames[frames.length - 1].min.length || 1;
    const total = WINDOW_FRAMES * pointsPer;
    const mins = frames.flatMap((f) => f.min);
    const maxs = frames.flatMap((f) => f.max);
    let peak = 1e-4;
    for (let i = 0; i < mins.length; i++) peak = Math.max(peak, maxs[i], -mins[i]);
    const yScale = (mid - 6) / peak;
    const offset = total - mins.length; // newest samples enter at the right edge

    ctx.fillStyle = t["series-audio"];
    for (let x = 0; x < W; x++) {
      const a = Math.floor((x / W) * total) - offset;
      const b = Math.floor(((x + 1) / W) * total) - offset;
      if (b <= 0) continue;
      let lo = Infinity, hi = -Infinity;
      for (let i = Math.max(0, a); i < Math.max(a + 1, b) && i < mins.length; i++) {
        if (mins[i] < lo) lo = mins[i];
        if (maxs[i] > hi) hi = maxs[i];
      }
      if (lo === Infinity) continue;
      const y1 = mid - hi * yScale, y2 = mid - lo * yScale;
      ctx.fillRect(x, y1, 1, Math.max(1, y2 - y1));
    }
    if (scaleLabel.current) scaleLabel.current.textContent = `auto-scale ±${peak.toFixed(peak < 0.01 ? 4 : 3)} FS`;
  });

  useEffect(() => subscribe((f) => {
    history.current.push(f.waveform);
    if (history.current.length > WINDOW_FRAMES) history.current.shift();
    markDirty();
  }), [subscribe, markDirty]);

  useEffect(() => {
    if (!live) { history.current = []; markDirty(); }
  }, [live, markDirty]);

  return (
    <figure className="viz">
      <div className="viz-head">
        <figcaption>Waveform <span className="muted">· last 5 s · 20 Hz high-pass</span></figcaption>
        <span ref={scaleLabel} className="muted tabular" />
      </div>
      <div className="viz-body">
        <canvas ref={canvas} className="canvas-wave" role="img"
          aria-label="Live audio waveform of the last five seconds" />
        {!live && <div className="viz-empty">No live audio. Start the input to see the waveform.</div>}
      </div>
      <div className="axis-x"><span>−5 s</span><span>now</span></div>
    </figure>
  );
}
