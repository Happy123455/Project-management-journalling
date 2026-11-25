// The voice cloud (Hapi, 25 Nov, from the reference video): while you talk, soft dots rise out of a
// liquid wave at the bottom and gather into each new word as it's heard, then the word settles in
// as text. Frosted glass card, round soft dots, springy (not stepped) motion at the display's rate.
// Draws only while something moves: at rest it paints one frame and sleeps (battery).
import { useEffect, useRef } from "react";

export type PillMode = "idle" | "listening" | "thinking" | "speaking";

interface Dot {
  x: number;
  y: number;
  tx: number;
  ty: number;
  vx: number;
  vy: number;
  delay: number;
  r: number;
}
interface Word {
  text: string;
  x: number;
  line: number;
  born: number;
  dots: Dot[];
}

const FONT = 17;
const LINE = 23;

export function VoicePill({ level, mode, text = "", placeholder = "", className = "" }: { level: React.RefObject<number>; mode: PillMode; text?: string; placeholder?: string; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const st = useRef({ mode, text, placeholder, wake: () => {} });
  st.current.mode = mode;
  st.current.text = text;
  st.current.placeholder = placeholder;
  useEffect(() => st.current.wake(), [mode, text]);

  useEffect(() => {
    const c = ref.current;
    const g = c?.getContext("2d");
    if (!c || !g) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    let w = 0;
    let h = 0;
    const fontCss = `500 ${FONT}px -apple-system, "SF Pro Text", system-ui, sans-serif`;
    // A scratch canvas to find where a word's ink is.
    const scratch = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
    let words: Word[] = [];
    let shown = "";
    let raf = 0;
    let last = performance.now();
    let t = 0;
    let smooth = 0;
    let scroll = 0;
    const color = () => getComputedStyle(c).color || "#222";
    let ink = color();

    const size = () => {
      w = c.clientWidth;
      h = c.clientHeight;
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      ink = color();
      layout(true);
      wake();
    };
    const pad = 14;
    const textH = () => Math.max(LINE, h - 46);

    /** Places the words (wrapping); new words get dots that fly up out of the wave into their letters. */
    const layout = (reflow = false) => {
      const target = st.current.text.trim();
      if (!reflow && target === shown) return;
      g.font = fontCss;
      const list = target ? target.split(/\s+/) : [];
      const keep = reflow ? 0 : words.findIndex((wd, i) => wd.text !== list[i]);
      const same = keep < 0 ? Math.min(words.length, list.length) : keep;
      const now = performance.now();
      const next: Word[] = [];
      let x = pad;
      let line = 0;
      const space = g.measureText(" ").width;
      list.forEach((word, i) => {
        const ww = g.measureText(word).width;
        if (x + ww > w - pad - 56 && x > pad) (x = pad), line++;
        const old = i < same ? words[i] : null;
        next.push(old && !reflow ? { ...old, x, line } : { text: word, x, line, born: old || reflow ? now - 2000 : now + (i - same) * 70, dots: old || reflow || reduce ? [] : dotsFor(word, h - 8 - (pad + line * LINE - scroll)) });
        x += ww + space;
      });
      words = next;
      shown = target;
    };

    const dotsFor = (word: string, fromY: number): Dot[] => {
      scratch.font = fontCss;
      const fw = Math.ceil(scratch.measureText(word).width) + 4 || 60;
      scratch.canvas.width = Math.max(4, fw * 2);
      scratch.canvas.height = LINE * 2;
      scratch.setTransform(2, 0, 0, 2, 0, 0);
      scratch.font = fontCss;
      scratch.textBaseline = "alphabetic";
      scratch.fillStyle = "#000";
      scratch.fillText(word, 0, FONT);
      const img = scratch.getImageData(0, 0, scratch.canvas.width, scratch.canvas.height).data;
      const out: Dot[] = [];
      const step = 3;
      for (let yy = 0; yy < scratch.canvas.height; yy += step)
        for (let xx = 0; xx < scratch.canvas.width; xx += step)
          if (img[(yy * scratch.canvas.width + xx) * 4 + 3] > 120)
            out.push({ x: 0, y: 0, tx: xx / 2, ty: yy / 2, vx: 0, vy: 0, delay: Math.random() * 160, r: 0.9 + Math.random() * 0.7 });
      // Start in the wave, spread around under the word.
      for (const d of out) {
        d.x = d.tx + (Math.random() - 0.5) * 140;
        d.y = fromY + Math.random() * 8;
        d.vx = (Math.random() - 0.5) * 60;
        d.vy = -120 - Math.random() * 120;
      }
      return out.length > 160 ? out.filter((_, i) => i % Math.ceil(out.length / 160) === 0) : out;
    };

    const wake = () => {
      if (!raf) {
        last = performance.now();
        raf = requestAnimationFrame(frame);
      }
    };
    st.current.wake = () => {
      layout();
      wake();
    };

    const frame = (now: number) => {
      raf = 0;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      t += dt;
      const m = st.current.mode;
      const target = m === "thinking" ? 0.22 + 0.1 * Math.sin(t * 2.4) : m === "idle" ? 0.03 : Math.min(1, (level.current ?? 0) * 3.4);
      smooth += (target - smooth) * Math.min(1, dt * (target > smooth ? 14 : 4));
      g.clearRect(0, 0, w, h);

      // Text: lines scroll so the newest stays in view.
      const lines = words.length ? words[words.length - 1].line + 1 : 0;
      const room = Math.max(1, Math.floor(textH() / LINE));
      const want = Math.max(0, lines - room) * LINE;
      scroll += (want - scroll) * Math.min(1, dt * 10);
      let moving = Math.abs(want - scroll) > 0.3;
      g.font = fontCss;
      g.textBaseline = "alphabetic";
      if (!words.length && st.current.placeholder) {
        g.globalAlpha = 0.45;
        g.fillStyle = ink;
        g.fillText(st.current.placeholder, pad, pad + FONT);
      }
      for (const wd of words) {
        const ox = wd.x;
        const oy = pad + wd.line * LINE - scroll;
        if (oy < -LINE || oy > h) continue;
        const age = (now - wd.born) / 1000;
        if (age < 0) {
          moving = true;
          continue;
        }
        // Dots spring towards the letters; the word fades in as they arrive.
        let settled = 0;
        g.fillStyle = ink;
        for (const d of wd.dots) {
          if (age * 1000 < d.delay) continue;
          const ax = (d.tx - d.x) * 90 - d.vx * 13;
          const ay = (d.ty - d.y) * 90 - d.vy * 13;
          d.vx += ax * dt;
          d.vy += ay * dt;
          d.x += d.vx * dt;
          d.y += d.vy * dt;
          const dist = Math.abs(d.tx - d.x) + Math.abs(d.ty - d.y);
          if (dist < 0.6) settled++;
          g.globalAlpha = Math.max(0, 0.85 - Math.max(0, age - 0.45) * 2.2);
          g.beginPath();
          g.arc(ox + d.x, oy + d.y, d.r, 0, 6.283);
          g.fill();
        }
        const fade = wd.dots.length ? Math.min(1, Math.max(0, (age - 0.3) * 3)) : Math.min(1, age * 4 + 0.2);
        if (fade < 1 || (wd.dots.length && age < 0.9)) moving = true;
        if (age > 0.9 && wd.dots.length && settled > wd.dots.length * 0.6) wd.dots = [];
        g.globalAlpha = fade;
        g.fillText(wd.text, ox, oy + FONT);
      }

      // The wave: round dots on a liquid surface, rising with the voice.
      const cols = Math.max(12, Math.floor(w / 7));
      const base = h - 10;
      for (let i = 0; i < cols; i++) {
        const x = (i + 0.5) * (w / cols);
        const u = i / cols;
        const env = Math.sin(Math.PI * u) ** 1.5;
        const wave = Math.sin(u * 9 + t * 3.2) * 0.5 + Math.sin(u * 23 - t * 4.7) * 0.3 + Math.sin(u * 4 + t * 1.3) * 0.2;
        const amp = (6 + 40 * smooth) * env * (0.6 + 0.4 * wave);
        const rows = Math.round(amp / 5);
        for (let r = 0; r < rows; r++) {
          const fall = 1 - r / rows;
          g.globalAlpha = (0.12 + 0.55 * fall) * (0.35 + smooth) * env;
          g.beginPath();
          g.arc(x, base - r * 5, 1.1 + fall * 0.9, 0, 6.283);
          g.fill();
        }
      }
      g.globalAlpha = 1;
      if (smooth > 0.035 || moving || m !== "idle") raf = requestAnimationFrame(frame);
    };

    const ro = new ResizeObserver(size);
    ro.observe(c);
    size();
    return () => {
      cancelAnimationFrame(raf);
      raf = 0;
      st.current.wake = () => {};
      ro.disconnect();
    };
  }, [level]);

  return <canvas ref={ref} className={`voice-pill-wave ${className}`} aria-hidden />;
}
