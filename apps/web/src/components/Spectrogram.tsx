import { useEffect, useMemo, useRef, useState } from "react";
import type { FrameListener } from "../hooks/useAudioService";
import { buildRamp, fitCanvas, readTokens, useDrawLoop } from "../lib/canvas";
import { formatHz } from "../lib/format";

const COLS = 300;                 // ~15 s at 20 frames/s
const SPAN_DB = 70;              // colour range height; the floor adapts to the measured background
const FLOOR_PCTL = 0.2;          // background estimate: 20th percentile of each column
const FLOOR_ALPHA = 0.02;        // slow EMA (~2.5 s) so colours don't pump with each sound
const SECONDS = 15;
const RAMP_TOKENS = ["seq-0", "seq-1", "seq-2", "seq-3", "seq-4", "seq-5"] as const;

interface Hover { x: number; y: number; hz: number; db: number; ago: number }

/** Scrolling spectrogram. Sequential single-hue ramp (surface → blue → near-white), never a rainbow. */
export function Spectrogram({ subscribe, live }: { subscribe: (fn: FrameListener) => () => void; live: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const offscreen = useRef<HTMLCanvasElement | null>(null);
  const columns = useRef<number[][]>([]);       // newest last, for hover lookup
  const lut = useRef<Uint8ClampedArray | null>(null);
  const lo = useRef<number | null>(null);         // adaptive colour-range floor, dBFS
  const rangeLo = useRef<HTMLSpanElement>(null);
  const rangeHi = useRef<HTMLSpanElement>(null);
  const level = (db: number) => {
    const min = lo.current ?? -120;
    return Math.round(Math.min(1, Math.max(0, (db - min) / SPAN_DB)) * 255) * 3;
  };
  const [fmax, setFmax] = useState(4000);
  const [hover, setHover] = useState<Hover | null>(null);
  const [rampCss, setRampCss] = useState("");

  const refreshRamp = () => {
    if (!canvas.current) return;
    const t = readTokens(canvas.current, RAMP_TOKENS);
    const stops = RAMP_TOKENS.map((k) => t[k]);
    lut.current = buildRamp(stops);
    setRampCss(`linear-gradient(to top, ${stops.join(", ")})`);
  };

  const paintAll = () => {
    const bins = columns.current.at(-1)?.length ?? 0;
    if (!bins || !lut.current) return;
    const off = (offscreen.current ??= document.createElement("canvas"));
    off.width = COLS;
    off.height = bins;
    const octx = off.getContext("2d")!;
    const img = octx.createImageData(COLS, bins);
    img.data.fill(0);
    const start = COLS - columns.current.length;
    columns.current.forEach((col, ci) => writeColumn(img.data, col, start + ci, bins));
    // background for empty columns
    const bg = lut.current;
    for (let x = 0; x < start; x++) for (let y = 0; y < bins; y++) {
      const p = (y * COLS + x) * 4;
      img.data[p] = bg[0]; img.data[p + 1] = bg[1]; img.data[p + 2] = bg[2]; img.data[p + 3] = 255;
    }
    octx.putImageData(img, 0, 0);
  };

  const writeColumn = (data: Uint8ClampedArray, col: number[], x: number, bins: number) => {
    const l = lut.current!;
    for (let i = 0; i < bins; i++) {
      const v = level(col[i]);
      const p = ((bins - 1 - i) * COLS + x) * 4; // low frequencies at the bottom
      data[p] = l[v]; data[p + 1] = l[v + 1]; data[p + 2] = l[v + 2]; data[p + 3] = 255;
    }
  };

  const markDirty = useDrawLoop(() => {
    const c = canvas.current;
    if (!c) return;
    fitCanvas(c);
    const ctx = c.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    if (!lut.current) refreshRamp();
    const bgTok = readTokens(c, ["surface-2"] as const)["surface-2"];
    ctx.fillStyle = bgTok;
    ctx.fillRect(0, 0, c.width, c.height);
    if (offscreen.current && columns.current.length) ctx.drawImage(offscreen.current, 0, 0, c.width, c.height);
  });

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onTheme = () => { refreshRamp(); paintAll(); markDirty(); };
    mq.addEventListener("change", onTheme);
    return () => mq.removeEventListener("change", onTheme);
  }, [markDirty]);

  useEffect(() => subscribe((f) => {
    const col = f.spectrum.db;
    const sorted = [...col].sort((a, b) => a - b);
    const bg = sorted[Math.floor(sorted.length * FLOOR_PCTL)] - 5;
    lo.current = lo.current === null ? bg : lo.current + (bg - lo.current) * FLOOR_ALPHA;
    if (rangeLo.current) rangeLo.current.textContent = `${Math.round(lo.current)}`;
    if (rangeHi.current) rangeHi.current.textContent = `${Math.round(lo.current + SPAN_DB)} dBFS`;
    if (columns.current.length && columns.current[0].length !== col.length) columns.current = [];
    columns.current.push(col);
    if (columns.current.length > COLS) columns.current.shift();
    setFmax((prev) => (prev === f.spectrum.fmax_hz ? prev : f.spectrum.fmax_hz));
    if (!lut.current) refreshRamp();
    // Shift the offscreen image one column left and paint the new column on the right.
    const off = offscreen.current;
    if (!off || off.height !== col.length) paintAll();
    else {
      const octx = off.getContext("2d")!;
      octx.drawImage(off, -1, 0);
      const img = octx.createImageData(1, col.length);
      const l = lut.current!;
      for (let i = 0; i < col.length; i++) {
        const v = level(col[i]);
        const p = (col.length - 1 - i) * 4;
        img.data[p] = l[v]; img.data[p + 1] = l[v + 1]; img.data[p + 2] = l[v + 2]; img.data[p + 3] = 255;
      }
      octx.putImageData(img, COLS - 1, 0);
    }
    markDirty();
  }), [subscribe, markDirty]);

  useEffect(() => {
    if (!live) { columns.current = []; offscreen.current = null; lo.current = null; markDirty(); }
  }, [live, markDirty]);

  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height;
    const colIdx = Math.floor(fx * COLS) - (COLS - columns.current.length);
    const col = columns.current[colIdx];
    if (!col) { setHover(null); return; }
    const bin = Math.min(col.length - 1, Math.max(0, Math.floor((1 - fy) * col.length)));
    setHover({ x: e.clientX - r.left, y: e.clientY - r.top, hz: ((bin + 0.5) / col.length) * fmax,
      db: col[bin], ago: (1 - fx) * SECONDS });
  };

  const ticks = useMemo(() => {
    const step = fmax > 3000 ? 1000 : 500;
    const out: number[] = [];
    for (let f = 0; f <= fmax + 1; f += step) out.push(f);
    return out;
  }, [fmax]);

  return (
    <figure className="viz">
      <div className="viz-head">
        <figcaption>Spectrogram <span className="muted">· last 15 s · 0–{formatHz(fmax)}</span></figcaption>
        <div className="colorbar" title="Auto-ranged: the floor follows the measured background, 70 dB span">
          <span className="muted small">auto</span>
          <span ref={rangeLo} className="muted tabular" />
          <span className="colorbar-swatch" style={{ background: rampCss.replace("to top", "to right") }} />
          <span ref={rangeHi} className="muted tabular">dBFS</span>
        </div>
      </div>
      <div className="spec-wrap">
        <div className="axis-y" aria-hidden>
          {ticks.slice().reverse().map((f) => <span key={f}>{f === 0 ? "0" : formatHz(f)}</span>)}
        </div>
        <div className="viz-body">
          <canvas ref={canvas} className="canvas-spec" onPointerMove={onMove} onPointerLeave={() => setHover(null)}
            role="img" aria-label="Live spectrogram, frequency against time" />
          {hover && (
            <div className="tooltip" style={{ left: hover.x, top: hover.y }}>
              <strong className="tabular">{formatHz(hover.hz)}</strong>
              <span className="tabular">{hover.db.toFixed(0)} dBFS</span>
              <span className="muted tabular">{hover.ago.toFixed(1)} s ago</span>
            </div>
          )}
          {!live && <div className="viz-empty">No live audio.</div>}
        </div>
      </div>
      <div className="axis-x indent"><span>−15 s</span><span>now</span></div>
    </figure>
  );
}
