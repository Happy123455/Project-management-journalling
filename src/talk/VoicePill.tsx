// The voice pill (Hapi's reference, 25 Nov): a soft card where your words appear at the top while a
// mound of ASCII characters at the bottom rises with your voice, and specks fly up out of it into
// the words. Calm when quiet; a slow drift while thinking; it stops drawing when nothing moves.
import { useEffect, useRef } from "react";

const RAMP = " .,:;-=+*x#%&$@W8M";
const FILL = "jZaWBWWB$M8%#%B*M%*8M&WW8BW$*W#o0J(xvXUmwdK%M#&88M*#W8M*8&*$8*%%&MB#W8&W*&%8M&*W#8qQYvxuf1t?";

export type PillMode = "idle" | "listening" | "thinking" | "speaking";

interface Speck {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
}

export function VoicePill({ level, mode, className = "" }: { level: React.RefObject<number>; mode: PillMode; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const g = c.getContext("2d");
    if (!g) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    let w = 0;
    let h = 0;
    const size = () => {
      w = c.clientWidth;
      h = c.clientHeight;
      c.width = w * dpr;
      c.height = h * dpr;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    size();
    const ro = new ResizeObserver(size);
    ro.observe(c);
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const specks: Speck[] = [];
    let smooth = 0;
    let raf = 0;
    let last = 0;
    let t = 0;
    let still = 0;
    const ink = getComputedStyle(c).color || "#222";
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      if (now - last < 33) return; // ~30 fps is plenty
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const m = modeRef.current;
      const target = m === "thinking" ? 0.18 + 0.08 * Math.sin(t * 2) : m === "idle" ? 0.04 : Math.min(1, (level.current ?? 0) * 3.2);
      smooth += (target - smooth) * (target > smooth ? 0.45 : 0.12);
      t += dt;
      if (smooth < 0.03 && !specks.length) {
        // Nothing moving: draw the resting line now and then only.
        if (++still % 8) return;
      } else still = 0;
      g.clearRect(0, 0, w, h);
      g.fillStyle = ink;
      const fs = 10;
      g.font = `${fs}px ui-monospace, SFMono-Regular, Menlo, monospace`;
      g.textBaseline = "bottom";
      const cw = fs * 0.6;
      const cols = Math.floor(w / cw);
      const cx = cols * (0.5 + 0.08 * Math.sin(t * 0.7));
      const rows = Math.floor((h * 0.55) / fs);
      for (let i = 0; i < cols; i++) {
        const d = (i - cx) / (cols * (0.22 + smooth * 0.12));
        const bump = Math.exp(-d * d) * (0.35 + 0.65 * Math.abs(Math.sin(i * 0.37 + t * 3.1)) * smooth + smooth);
        const height = Math.max(m === "idle" ? 0.15 : 0.25, bump * rows * (0.4 + smooth));
        for (let r = 0; r < Math.ceil(height); r++) {
          const fall = 1 - r / Math.max(1, height);
          const edge = Math.exp(-d * d * 1.4);
          g.globalAlpha = Math.max(0.08, Math.min(0.9, fall * edge * (0.45 + smooth)));
          const ch = r === Math.ceil(height) - 1 ? RAMP[Math.min(RAMP.length - 1, Math.floor(fall * 6 + 1))] : FILL[(i * 7 + r * 13 + Math.floor(t * 6)) % FILL.length];
          g.fillText(ch, i * cw, h - r * fs);
        }
        if (!reduce && smooth > 0.25 && Math.random() < smooth * 0.02 && specks.length < 50) {
          specks.push({ x: i * cw, y: h - height * fs, vx: (Math.random() - 0.75) * 50, vy: -(60 + Math.random() * 120 * smooth), life: 1 });
        }
      }
      for (let k = specks.length - 1; k >= 0; k--) {
        const s = specks[k];
        s.x += s.vx * dt;
        s.y += s.vy * dt;
        s.vy += 30 * dt;
        s.life -= dt * 0.8;
        if (s.life <= 0 || s.y < 0) {
          specks.splice(k, 1);
          continue;
        }
        g.globalAlpha = s.life;
        g.fillRect(s.x, s.y, 3, 3);
        g.globalAlpha = s.life * 0.35;
        g.fillRect(s.x - s.vx * 0.04, s.y - s.vy * 0.04, 2, 2);
      }
      g.globalAlpha = 1;
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [level]);
  return <canvas ref={ref} className={`voice-pill-wave ${className}`} aria-hidden />;
}
