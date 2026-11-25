// The voice cloud. 25 Nov, Hapi, with the reference (bluma.design "Murmur"): the squares going up
// and down with the voice should themselves travel and become the words, not new squares
// appearing from nowhere; and the AI's words in a colour of their own.
//
// So: a mound of small squares rises from the bottom with the voice. When a word is heard, pieces
// peel off the top of the mound (the mound dips where they left) and stream along an arc, one
// after another, into the shape of the word's letters; once they've landed the word settles into
// text. Your words are in the text colour, the AI's in its own (--ai-ink, purple by default).
// Draws only while something moves: at rest it paints one frame and sleeps (battery).
import { useEffect, useRef } from "react";

export type PillMode = "idle" | "listening" | "thinking" | "speaking";

interface Piece {
  /** Where it left the mound, the arc's bend, where it lands (word space). */
  sx: number;
  sy: number;
  cx: number;
  cy: number;
  tx: number;
  ty: number;
  /** When it leaves (ms after the word's birth) and how long the flight takes. */
  delay: number;
  dur: number;
  size: number;
}
interface Word {
  text: string;
  x: number;
  line: number;
  born: number;
  pieces: Piece[];
  ai: boolean;
}

const FONT = 17;
const LINE = 23;
/** The mound's squares: their size and the gap between rows. */
const SQ = 2.2;
const ROW = 4.6;

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

export function VoicePill({
  level,
  mode,
  text = "",
  placeholder = "",
  className = "",
  who,
}: {
  level: React.RefObject<number>;
  mode: PillMode;
  text?: string;
  placeholder?: string;
  className?: string;
  /** Whose words: "ai" draws them in the AI colour. Default: the AI while it's speaking. */
  who?: "me" | "ai";
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const ai = who ? who === "ai" : mode === "speaking";
  const st = useRef({ mode, text, placeholder, ai, wake: () => {} });
  st.current.mode = mode;
  st.current.text = text;
  st.current.placeholder = placeholder;
  st.current.ai = ai;
  useEffect(() => st.current.wake(), [mode, text, ai]);

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
    let shownAi = false;
    let raf = 0;
    let last = performance.now();
    let t = 0;
    let smooth = 0;
    let scroll = 0;
    /** How much of the mound has just flown off (it dips, then grows back). */
    let drain = 0;
    let ink = "#222";
    let aiInk = "#8b5cf6";
    const colors = () => {
      const cs = getComputedStyle(c);
      ink = cs.color || "#222";
      aiInk = cs.getPropertyValue("--ai-ink").trim() || "#8b5cf6";
    };

    const size = () => {
      w = c.clientWidth;
      h = c.clientHeight;
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      colors();
      layout(true);
      wake();
    };
    const pad = 14;
    const textH = () => Math.max(LINE, h - 50);
    const base = () => h - 8;
    const cols = () => Math.max(14, Math.floor(w / 6.5));
    /** The mound's height (px) at column i: a hill in the middle that breathes with the voice. */
    const heightAt = (i: number, n: number) => {
      const u = (i + 0.5) / n;
      const env = Math.exp(-(((u - 0.5) / 0.2) ** 2));
      const wave = Math.sin(u * 9 + t * 3.2) * 0.5 + Math.sin(u * 23 - t * 4.7) * 0.3 + Math.sin(u * 4 + t * 1.3) * 0.2;
      return (5 + 44 * smooth * (1 - 0.45 * drain)) * env * (0.7 + 0.3 * wave) + 2;
    };

    /** Places the words (wrapping); a new word's pieces leave the mound for its letters. */
    const layout = (reflow = false) => {
      const target = st.current.text.trim();
      const isAi = st.current.ai;
      if (!reflow && target === shown && isAi === shownAi) return;
      g.font = fontCss;
      const list = target ? target.split(/\s+/) : [];
      const keep = reflow || isAi !== shownAi ? 0 : words.findIndex((wd, i) => wd.text !== list[i]);
      const same = keep < 0 ? Math.min(words.length, list.length) : keep;
      const now = performance.now();
      const next: Word[] = [];
      let x = pad;
      let line = 0;
      const space = g.measureText(" ").width;
      let fresh = 0;
      list.forEach((word, i) => {
        const ww = g.measureText(word).width;
        if (x + ww > w - pad - 56 && x > pad) (x = pad), line++;
        const old = i < same ? words[i] : null;
        if (old && !reflow) next.push({ ...old, x, line });
        else {
          const born = old || reflow ? now - 3000 : now + fresh++ * 110;
          next.push({ text: word, x, line, born, ai: isAi, pieces: old || reflow || reduce ? [] : piecesFor(word, x, pad + line * LINE - scroll) });
        }
        x += ww + space;
      });
      words = next;
      shown = target;
      shownAi = isAi;
      if (fresh) drain = Math.min(1, drain + 0.35 * fresh);
    };

    /** The letters' ink as squares, each one leaving from the top of the mound. */
    const piecesFor = (word: string, wx: number, wy: number): Piece[] => {
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
      let spots: { x: number; y: number }[] = [];
      const step = 3;
      for (let yy = 0; yy < scratch.canvas.height; yy += step)
        for (let xx = 0; xx < scratch.canvas.width; xx += step) if (img[(yy * scratch.canvas.width + xx) * 4 + 3] > 120) spots.push({ x: xx / 2, y: yy / 2 });
      if (spots.length > 150) spots = spots.filter((_, i) => i % Math.ceil(spots.length / 150) === 0);
      // Left to right, so the stream draws the word in reading order.
      spots.sort((a, b) => a.x - b.x || a.y - b.y);
      const n = cols();
      const out: Piece[] = [];
      spots.forEach((s, k) => {
        // From a column near the top of the hill (in page space, made relative to the word).
        const i = Math.round(n / 2 + (Math.random() - 0.5) * n * 0.32);
        const px = (i + 0.5) * (w / n);
        const py = base() - heightAt(i, n) + Math.random() * 6;
        const sx = px - wx;
        const sy = py - wy;
        const tx = s.x;
        const ty = s.y;
        // The arc bends up and towards the word, like a stream thrown from the hill.
        const cx = sx + (tx - sx) * 0.35 + (Math.random() - 0.5) * 18;
        const cy = Math.min(sy, ty) - 26 - Math.random() * 22;
        out.push({ sx, sy, cx, cy, tx, ty, delay: k * 5 + Math.random() * 25, dur: 520 + Math.random() * 220, size: SQ * (0.75 + Math.random() * 0.35) });
      });
      return out;
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
      drain = Math.max(0, drain - dt * 1.4);
      g.clearRect(0, 0, w, h);

      // Text: lines scroll so the newest stays in view.
      const lines = words.length ? words[words.length - 1].line + 1 : 0;
      const room = Math.max(1, Math.floor(textH() / LINE));
      const want = Math.max(0, lines - room) * LINE;
      scroll += (want - scroll) * Math.min(1, dt * 10);
      let moving = Math.abs(want - scroll) > 0.3 || drain > 0;
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
        const age = now - wd.born;
        if (age < 0) {
          moving = true;
          continue;
        }
        const color = wd.ai ? aiInk : ink;
        g.fillStyle = color;
        let landed = 0;
        let lastLand = 0;
        for (const p of wd.pieces) {
          const k = (age - p.delay) / p.dur;
          if (k <= 0) continue;
          const e = ease(Math.min(1, k));
          // Along the arc (a quadratic curve from the hill to the letter).
          const x = (1 - e) * (1 - e) * p.sx + 2 * (1 - e) * e * p.cx + e * e * p.tx;
          const y = (1 - e) * (1 - e) * p.sy + 2 * (1 - e) * e * p.cy + e * e * p.ty;
          if (k >= 1) landed++;
          lastLand = Math.max(lastLand, p.delay + p.dur);
          g.globalAlpha = k >= 1 ? 0.9 : 0.55 + 0.4 * e;
          const s = p.size * (k >= 1 ? 0.85 : 1.15 - 0.3 * e);
          g.fillRect(ox + x - s / 2, oy + y - s / 2, s, s);
        }
        // The squares settle into the word once they've all landed.
        const settled = wd.pieces.length ? Math.min(1, Math.max(0, (age - lastLand) / 260)) : Math.min(1, age / 250 + 0.2);
        if (settled < 1 || (wd.pieces.length && landed < wd.pieces.length)) moving = true;
        if (wd.pieces.length && settled >= 1) wd.pieces = [];
        if (settled > 0) {
          g.globalAlpha = settled;
          g.fillText(wd.text, ox, oy + FONT);
        }
      }

      // The mound: columns of small squares, a hill that rises and breathes with the voice.
      const n = cols();
      const b = base();
      g.fillStyle = st.current.ai && m === "speaking" ? aiInk : ink;
      for (let i = 0; i < n; i++) {
        const x = (i + 0.5) * (w / n);
        const hh = heightAt(i, n);
        const rows = Math.max(1, Math.round(hh / ROW));
        for (let r = 0; r < rows; r++) {
          const fall = 1 - r / rows;
          g.globalAlpha = (0.1 + 0.6 * fall) * (0.4 + smooth * 0.8);
          const s = SQ * (0.7 + 0.45 * fall);
          g.fillRect(x - s / 2, b - r * ROW - s / 2, s, s);
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

  return <canvas ref={ref} className={`voice-pill-wave ${className}${ai ? " ai" : ""}`} aria-hidden />;
}
