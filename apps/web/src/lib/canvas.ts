import { useCallback, useEffect, useRef } from "react";

/** Resize a canvas backing store to its CSS size × devicePixelRatio. Returns true if it changed. */
export function fitCanvas(c: HTMLCanvasElement): boolean {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(c.clientWidth * dpr));
  const h = Math.max(1, Math.round(c.clientHeight * dpr));
  if (c.width === w && c.height === h) return false;
  c.width = w;
  c.height = h;
  return true;
}

/** Read theme tokens (CSS custom properties) so canvases follow light/dark mode. */
export function readTokens<K extends string>(el: Element, names: readonly K[]): Record<K, string> {
  const cs = getComputedStyle(el);
  const out = {} as Record<K, string>;
  for (const n of names) out[n] = cs.getPropertyValue(`--${n}`).trim();
  return out;
}

/** requestAnimationFrame loop that only calls draw() when marked dirty (or on resize). */
export function useDrawLoop(draw: () => void) {
  const dirty = useRef(true);
  const drawRef = useRef(draw);
  drawRef.current = draw;
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      if (dirty.current) {
        dirty.current = false;
        drawRef.current();
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    const onResize = () => (dirty.current = true);
    window.addEventListener("resize", onResize);
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", onResize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      mq.removeEventListener("change", onResize);
    };
  }, []);
  return useCallback(() => { dirty.current = true; }, []);
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Build a 256-entry lookup table interpolating through the given hex stops. */
export function buildRamp(stops: string[]): Uint8ClampedArray {
  const rgb = stops.map(hexToRgb);
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = (i / 255) * (rgb.length - 1);
    const k = Math.min(rgb.length - 2, Math.floor(t));
    const f = t - k;
    for (let c = 0; c < 3; c++) lut[i * 3 + c] = rgb[k][c] + (rgb[k + 1][c] - rgb[k][c]) * f;
  }
  return lut;
}
