import { ARROW, ease, node, piecesOf, speedUp, swarmOff, swarmRate } from "./run";
import { haptic } from "../../lib/haptic";

/**
 * Two "deleting" shows (Hapi, 18 Nov: the delete happened far too quickly):
 *  - demolish(): an agent deletes a block in the open note. The block stays in its place while a
 *    small crew selects it, strikes each line through, the lines crumble into dust, a sweeper
 *    brushes the spot clean and the text under it slides up to close the gap.
 *  - dismissBubble(): a floating agent bubble dropped on Home. It squashes towards Home, cracks
 *    into sparks that spiral into Home, Home swallows them and a ripple says it's closed.
 * Like the build swarm (run.ts): Web Animations on a few throwaway nodes, no frame loop, no React
 * state; the note's own nodes are only animated (never styled), and everything is removed after.
 */

const rand = (a: number, b: number) => a + Math.random() * (b - a);

/** One deleted block, as it was on screen before the change (kept by watch.ts). */
export interface GoneBlock {
  /** A copy of the block taken before it went. */
  clone: HTMLElement;
  /** Its index among the note's top-level blocks, before the change. */
  index: number;
  /** Where it sat, relative to the note's top left corner. */
  top: number;
  left: number;
  width: number;
  height: number;
}

function finish(root: HTMLElement, anims: Animation[], T: number, extra?: () => void): Promise<void> {
  T = speedUp(anims, T, swarmRate());
  return new Promise<void>((resolve) => {
    let over = false;
    const end = () => {
      if (over) return;
      over = true;
      for (const a of anims) a.cancel();
      root.remove();
      extra?.();
      resolve();
    };
    anims[0]?.finished.then(end, end);
    window.setTimeout(end, T + 250);
  });
}

let demolishing = 0;

/** Plays the deletion of `gone` over the note `pm`. Resolves when it's over. */
export function demolish(pm: HTMLElement, gone: GoneBlock, label = "Agent"): Promise<void> {
  if (swarmOff() || demolishing >= 2 || typeof pm.animate !== "function") return Promise.resolve();
  const base = pm.getBoundingClientRect();
  const x0 = base.left + gone.left;
  const y0 = base.top + gone.top;
  const h = gone.height;
  if (y0 + h < 0 || y0 > window.innerHeight || gone.width < 10 || h < 6) return Promise.resolve();
  demolishing++;
  const T = 3000;
  const off = (ms: number) => Math.min(1, Math.max(0, ms / T));
  const anims: Animation[] = [];
  const run = (n: Element, k: Keyframe[], o: KeyframeAnimationOptions = {}) => anims.push(n.animate(k, { duration: T, fill: "both", easing: "linear", ...o }));

  const root = node("swarm swarm-gone", document.body);
  root.setAttribute("aria-hidden", "true");
  const stage = node("swarm-stage", root);

  // The block, back in its place: a copy inside the note's own classes so it looks the same.
  const ghostAt = (clip?: string) => {
    const host = node("swarm-ghost editor", stage);
    Object.assign(host.style, { left: `${x0}px`, top: `${y0}px`, width: `${gone.width}px` });
    const pmCopy = node("ProseMirror tiptap", host);
    const c = gone.clone.cloneNode(true) as HTMLElement;
    c.style.margin = "0";
    pmCopy.appendChild(c);
    if (clip) host.style.clipPath = clip;
    return host;
  };
  const whole = ghostAt();
  const pieces = (() => {
    const c = whole.querySelector<HTMLElement>(".ProseMirror > *");
    const p = c ? piecesOf(c) : [];
    return p.slice(0, 8);
  })();

  // The text under it is held where it was (the editor already closed the gap) until the sweep.
  const below = (Array.from(pm.children) as HTMLElement[]).slice(gone.index).filter((el) => {
    const r = el.getBoundingClientRect();
    return r.top < window.innerHeight + 40;
  });
  const sweepAt = 2050;
  const closeAt = 2350;
  for (const el of below.slice(0, 40))
    run(el, [{ transform: `translateY(${h}px)`, offset: 0 }, { transform: `translateY(${h}px)`, offset: off(sweepAt) }, { transform: "translateY(0)", offset: off(closeAt + 450), easing: ease }, { transform: "translateY(0)", offset: 1 }], { fill: "none" });

  // Selected: a red frame draws round it and it blushes once.
  const frame = node("swarm-frame swarm-frame-del", stage);
  Object.assign(frame.style, { left: `${x0 - 4}px`, top: `${y0 - 3}px`, width: `${gone.width + 8}px`, height: `${h + 6}px` });
  run(frame, [
    { opacity: 0, transform: "scale(1.06)", offset: 0 },
    { opacity: 0, transform: "scale(1.06)", offset: off(380) },
    { opacity: 1, transform: "scale(1)", offset: off(700), easing: ease },
    { opacity: 1, transform: "scaleY(1)", offset: off(closeAt) },
    { opacity: 0, transform: "scaleY(0.02)", offset: off(closeAt + 420), easing: "ease-in" },
    { opacity: 0, offset: 1 },
  ]);
  const blush = node("swarm-blush", frame);
  run(blush, [{ opacity: 0, offset: 0 }, { opacity: 0, offset: off(620) }, { opacity: 0.55, offset: off(800) }, { opacity: 0.2, offset: off(1050) }, { opacity: 0.2, offset: off(sweepAt) }, { opacity: 0, offset: off(closeAt) }, { opacity: 0, offset: 1 }]);

  // Each line: struck through left to right, then it cracks off and falls away as dust.
  const startCrumble = 1000;
  const span = 1000;
  const step = pieces.length > 1 ? span / pieces.length : 0;
  run(whole, [{ opacity: 1, offset: 0 }, { opacity: 1, offset: off(startCrumble) }, { opacity: pieces.length ? 0 : 1, offset: off(startCrumble + 1) }, ...(pieces.length ? [] : [{ opacity: 1, transform: "none", filter: "blur(0px)", offset: off(sweepAt - 300) }, { opacity: 0, transform: "scale(0.92) translateY(10px)", filter: "blur(4px)", offset: off(sweepAt + 100) }]), { opacity: 0, offset: 1 }]);
  const strikes: { x: number; y: number; w: number; at: number }[] = [];
  let dust = 0;
  pieces.forEach((p, i) => {
    const at = startCrumble + i * step;
    const strikeEnd = at + 260;
    const fall = strikeEnd + 60;
    strikes.push({ x: x0 + p.x, y: y0 + p.y + p.h / 2, w: p.w, at });
    // Its own copy, cut to this line, so the line itself breaks away.
    const bit = ghostAt(`inset(${Math.max(0, p.y - 1)}px ${Math.max(0, gone.width - p.x - p.w - 1)}px ${Math.max(0, h - p.y - p.h - 1)}px ${Math.max(0, p.x - 1)}px)`);
    const dx = rand(-24, 24);
    const rot = rand(-14, 14);
    run(bit, [
      { opacity: 0, offset: 0 },
      { opacity: 0, offset: off(startCrumble) },
      { opacity: 1, transform: "none", offset: off(startCrumble + 1) },
      { opacity: 1, transform: "none", offset: off(fall) },
      { opacity: 1, transform: `translate(${dx * 0.2}px, -4px) rotate(${rot * 0.2}deg)`, offset: off(fall + 120), easing: "ease-out" },
      { opacity: 0, transform: `translate(${dx}px, ${rand(38, 70)}px) rotate(${rot}deg) scale(0.9)`, filter: "blur(2px)", offset: off(fall + 640), easing: "cubic-bezier(0.55, 0, 0.9, 0.5)" },
      { opacity: 0, offset: 1 },
    ]);
    // The red strike over it.
    const s = node("swarm-strike", stage);
    Object.assign(s.style, { left: `${x0 + p.x}px`, top: `${y0 + p.y + p.h / 2 - 1}px`, width: `${p.w}px` });
    run(s, [{ transform: "scaleX(0)", opacity: 1, offset: 0 }, { transform: "scaleX(0)", opacity: 1, offset: off(at) }, { transform: "scaleX(1)", opacity: 1, offset: off(strikeEnd), easing: "ease-out" }, { transform: "scaleX(1)", opacity: 1, offset: off(fall) }, { transform: "scaleX(1) translateY(30px)", opacity: 0, offset: off(fall + 420), easing: "ease-in" }, { opacity: 0, offset: 1 }]);
    // Dust from where it broke.
    for (let k = 0; k < 4 && dust < 28; k++, dust++) {
      const d = node("swarm-dust", stage);
      const sx = x0 + p.x + rand(0.1, 0.9) * p.w;
      const sy = y0 + p.y + p.h * rand(0.3, 0.9);
      Object.assign(d.style, { left: `${sx}px`, top: `${sy}px` });
      const ex = rand(-30, 30);
      const ey = rand(20, 60);
      run(d, [{ opacity: 0, transform: "scale(0.4)", offset: 0 }, { opacity: 0, transform: "scale(0.4)", offset: off(fall) }, { opacity: 0.9, transform: `translate(${ex * 0.3}px, ${-rand(6, 16)}px) scale(1)`, offset: off(fall + 160), easing: "ease-out" }, { opacity: 0, transform: `translate(${ex}px, ${ey}px) scale(0.3)`, offset: off(fall + 820), easing: "ease-in" }, { opacity: 0, offset: 1 }]);
    }
  });

  // The crew: an Eraser strikes the lines, a Sweeper brushes the spot clean, a Checker (bigger blocks) looks it over.
  const W = window.innerWidth;
  const H = window.innerHeight;
  const crew = [
    { role: "Eraser", icon: "⌫", hue: 0, from: { x: -0.08, y: 0.2 } },
    { role: "Sweeper", icon: "🧹", hue: 32, from: { x: 1.08, y: 0.55 } },
    ...(pieces.length > 3 ? [{ role: "Checker", icon: "✓", hue: 150, from: { x: 0.5, y: 1.1 } }] : []),
  ];
  crew.forEach((a, i) => {
    const me = node("swarm-agent", stage, `${ARROW}<span class="swarm-tag"><b>${a.icon}</b>${a.role}</span>`);
    me.style.setProperty("--h", String(a.hue));
    const start = { x: a.from.x * W, y: a.from.y * H };
    const k: Keyframe[] = [{ transform: `translate3d(${start.x}px, ${start.y}px, 0)`, offset: 0 }];
    let t = 0;
    const at = (ms: number, x: number, y: number, easing = ease) => {
      const o = off(ms);
      if (o <= t) return;
      t = o;
      k.push({ transform: `translate3d(${x}px, ${y}px, 0)`, offset: o, easing });
    };
    const ripple = (ms: number, x: number, y: number) => {
      const rp = node("swarm-ripple", stage);
      rp.style.setProperty("--h", String(a.hue));
      Object.assign(rp.style, { left: `${x}px`, top: `${y}px` });
      run(rp, [{ transform: "scale(0.2)", opacity: 0, offset: 0 }, { transform: "scale(0.2)", opacity: 0.9, offset: off(ms) }, { transform: "scale(2.6)", opacity: 0, offset: off(ms + 520), easing: "ease-out" }, { opacity: 0, offset: 1 }]);
    };
    if (a.role === "Eraser") {
      at(420, x0 + 6, y0 + 10);
      ripple(560, x0 + 6, y0 + 10);
      at(720, x0 + 8, y0 + 12, "ease-out");
      for (const s of strikes) {
        at(s.at, s.x + 2, s.y + 6);
        at(s.at + 260, s.x + s.w - 4, s.y + 6, "linear");
      }
      if (!strikes.length) {
        at(1100, x0 + 8, y0 + h / 2);
        at(1500, x0 + gone.width - 10, y0 + h / 2, "linear");
      }
      at(sweepAt - 100, x0 + gone.width * 0.85, y0 - 16);
    } else if (a.role === "Sweeper") {
      at(560, x0 + gone.width + 8, y0 + h * 0.6);
      at(sweepAt - 60, x0 + gone.width - 6, y0 + h * 0.5);
      // Brushes across, twice, quick.
      at(sweepAt + 160, x0 + 4, y0 + h * 0.55, "ease-in-out");
      at(sweepAt + 320, x0 + gone.width * 0.6, y0 + h * 0.4, "ease-in-out");
      ripple(sweepAt + 340, x0 + gone.width * 0.6, y0 + h * 0.4);
    } else {
      at(700, x0 + gone.width * 0.5, y0 + h + 14);
      at(1500, x0 + gone.width * 0.3, y0 + h * 0.7, "ease-in-out");
      at(closeAt + 200, x0 + gone.width * 0.5, y0 + 6);
      ripple(closeAt + 220, x0 + gone.width * 0.5, y0 + 6);
    }
    k.push({ transform: `translate3d(${start.x * 0.7 + x0 * 0.3}px, ${start.y * 0.7 + y0 * 0.3}px, 0) scale(0.8)`, offset: 1, easing: "ease-in" });
    run(me, k);
    run(me, [{ opacity: 0, offset: 0 }, { opacity: 1, offset: off(150 + i * 80) }, { opacity: 1, offset: off(T - 380) }, { opacity: 0, offset: 1 }]);
  });

  // A small note where it was: deleted, and by whom.
  const chip = node("swarm-gone-chip", stage, `🗑 Deleted by ${label.replace(/[<>&]/g, "")}`);
  Object.assign(chip.style, { left: `${x0 + 4}px`, top: `${y0 + 2}px` });
  run(chip, [{ opacity: 0, transform: "translateY(4px) scale(0.9)", offset: 0 }, { opacity: 0, transform: "translateY(4px) scale(0.9)", offset: off(closeAt + 150) }, { opacity: 1, transform: "none", offset: off(closeAt + 330), easing: ease }, { opacity: 1, transform: "none", offset: off(T - 160) }, { opacity: 0, transform: "translateY(-6px)", offset: 1 }]);

  haptic("tick", 0.6);
  const buzz = window.setTimeout(() => haptic("tick", 0.4), startCrumble + 300);
  const buzz2 = window.setTimeout(() => haptic("edge", 0.5), closeAt + 300);

  // The page may scroll under it.
  const top0 = base.top;
  const follow = () => {
    if (!pm.isConnected) return;
    const r = pm.getBoundingClientRect();
    stage.style.transform = `translate3d(0, ${r.top - top0}px, 0)`;
  };
  window.addEventListener("scroll", follow, { capture: true, passive: true });
  return finish(root, anims, T, () => {
    window.removeEventListener("scroll", follow, { capture: true });
    window.clearTimeout(buzz);
    window.clearTimeout(buzz2);
    demolishing--;
  });
}

/**
 * A floating agent bubble dropped on Home: it squashes, cracks into sparks that spiral into Home,
 * Home gulps them and a ripple and a small "closed" label rise from it. About 1.9 s.
 */
export function dismissBubble(from: { x: number; y: number }, home: { x: number; y: number }, label: string, homeEl?: HTMLElement | null): Promise<void> {
  if (swarmOff()) return Promise.resolve();
  const T = 1900;
  const off = (ms: number) => Math.min(1, Math.max(0, ms / T));
  const anims: Animation[] = [];
  const run = (n: Element, k: Keyframe[], o: KeyframeAnimationOptions = {}) => anims.push(n.animate(k, { duration: T, fill: "both", easing: "linear", ...o }));
  const root = node("swarm swarm-dismiss", document.body);
  root.setAttribute("aria-hidden", "true");
  const stage = node("swarm-stage", root);
  const dx = home.x - from.x;
  const dy = home.y - from.y;
  const ang = Math.atan2(dy, dx);
  const deg = (ang * 180) / Math.PI;

  // The bubble: leans toward Home (squash and stretch), wobbles, then shrinks as it cracks.
  const bubble = node("swarm-dbubble", stage, `<span>✦</span>`);
  Object.assign(bubble.style, { left: `${from.x}px`, top: `${from.y}px` });
  run(bubble, [
    { transform: "translate(-50%, -50%) rotate(0deg) scale(1)", offset: 0 },
    { transform: `translate(-50%, -50%) rotate(${deg}deg) scale(1.22, 0.8) rotate(${-deg}deg)`, offset: off(160), easing: ease },
    { transform: `translate(-50%, -50%) rotate(${deg}deg) scale(0.9, 1.1) rotate(${-deg}deg)`, offset: off(300) },
    { transform: "translate(-50%, -50%) scale(1.05)", offset: off(420) },
    { transform: "translate(-50%, -50%) scale(1.12)", offset: off(560), easing: "ease-in" },
    { transform: "translate(-50%, -50%) scale(0.2)", opacity: 0, offset: off(680), easing: "ease-in" },
    { transform: "translate(-50%, -50%) scale(0.2)", opacity: 0, offset: 1 },
  ]);
  // Cracks of light across it just before it breaks.
  const crack = node("swarm-dcrack", bubble);
  run(crack, [{ opacity: 0, transform: "scale(0.6) rotate(0deg)", offset: 0 }, { opacity: 0, offset: off(380) }, { opacity: 1, transform: "scale(1) rotate(25deg)", offset: off(560) }, { opacity: 0, transform: "scale(1.4) rotate(40deg)", offset: off(700) }, { opacity: 0, offset: 1 }]);
  // A ring flashes out as it breaks.
  const flash = node("swarm-dflash", stage);
  Object.assign(flash.style, { left: `${from.x}px`, top: `${from.y}px` });
  run(flash, [{ opacity: 0, transform: "translate(-50%, -50%) scale(0.4)", offset: 0 }, { opacity: 0, offset: off(600) }, { opacity: 0.9, transform: "translate(-50%, -50%) scale(0.6)", offset: off(640) }, { opacity: 0, transform: "translate(-50%, -50%) scale(2.2)", offset: off(980), easing: "ease-out" }, { opacity: 0, offset: 1 }]);

  // Its number floats up and fades: "Agent 2 · closing".
  const tag = node("swarm-dtag", stage, `${label.replace(/[<>&]/g, "")} · closing`);
  Object.assign(tag.style, { left: `${from.x}px`, top: `${from.y - 40}px` });
  run(tag, [{ opacity: 0, transform: "translate(-50%, 6px) scale(0.9)", offset: 0 }, { opacity: 1, transform: "translate(-50%, 0) scale(1)", offset: off(240), easing: ease }, { opacity: 1, transform: "translate(-50%, -6px)", offset: off(900) }, { opacity: 0, transform: "translate(-50%, -22px)", offset: off(1250) }, { opacity: 0, offset: 1 }]);

  // Sparks: burst out, then each spirals into Home on its own path.
  const N = 12;
  for (let i = 0; i < N; i++) {
    const s = node(`swarm-spark sk-${i % 3}`, stage, i % 4 === 0 ? "✦" : "");
    Object.assign(s.style, { left: `${home.x}px`, top: `${home.y}px` });
    const a = (i / N) * Math.PI * 2 + rand(-0.2, 0.2);
    const burst = rand(26, 48);
    const bx = from.x + Math.cos(a) * burst - home.x;
    const by = from.y + Math.sin(a) * burst - home.y;
    const k: Keyframe[] = [
      { transform: `translate(${from.x - home.x}px, ${from.y - home.y}px) scale(0)`, opacity: 0, offset: 0 },
      { transform: `translate(${from.x - home.x}px, ${from.y - home.y}px) scale(0)`, opacity: 0, offset: off(620) },
      { transform: `translate(${bx}px, ${by}px) scale(1.15)`, opacity: 1, offset: off(800), easing: "ease-out" },
    ];
    // The swoop to Home: straight in, bowed out to one side and back (alternate sides), so the
    // sparks swirl round each other on the way and land one after another.
    const start = 860 + i * 38;
    const len = 620 + rand(-60, 80);
    const L = Math.hypot(bx, by) || 1;
    const px = -by / L;
    const py = bx / L;
    const bow = (i % 2 ? 1 : -1) * Math.min(110, L * 0.35) * rand(0.6, 1.1);
    k.push({ transform: `translate(${bx}px, ${by}px) scale(1)`, opacity: 1, offset: off(start) });
    for (let j = 1; j <= 6; j++) {
      const f = j / 6;
      const e = f * f * (3 - 2 * f);
      const side = Math.sin(Math.PI * f) * bow;
      k.push({ transform: `translate(${bx * (1 - e) + px * side}px, ${by * (1 - e) + py * side}px) scale(${1 - f * 0.6})`, opacity: j === 6 ? 0 : 1, offset: off(start + len * f), easing: "linear" });
    }
    k.push({ opacity: 0, transform: "translate(0, 0) scale(0)", offset: 1 });
    run(s, k);
  }
  // Home swallows them: a gulp as the last sparks land, and a ripple goes out.
  if (homeEl && typeof homeEl.animate === "function")
    anims.push(homeEl.animate([{ transform: "scale(1)", offset: 0 }, { transform: "scale(1)", offset: off(900) }, { transform: "scale(1.16)", offset: off(1150) }, { transform: "scale(1.28)", offset: off(1500) }, { transform: "scale(0.84)", offset: off(1640), easing: "ease-in" }, { transform: "scale(1.06)", offset: off(1780) }, { transform: "scale(1)", offset: 1 }], { duration: T, easing: "ease-out", fill: "none" }));
  for (let i = 0; i < 2; i++) {
    const ring = node("swarm-dring", stage);
    Object.assign(ring.style, { left: `${home.x}px`, top: `${home.y}px` });
    const at = 1560 + i * 140;
    run(ring, [{ opacity: 0, transform: "translate(-50%, -50%) scale(0.5)", offset: 0 }, { opacity: 0, offset: off(at) }, { opacity: 0.8, transform: "translate(-50%, -50%) scale(0.7)", offset: off(at + 20) }, { opacity: 0, transform: "translate(-50%, -50%) scale(2.6)", offset: Math.min(1, off(at + 330)), easing: "ease-out" }, { opacity: 0, offset: 1 }]);
  }
  const done = node("swarm-dtag swarm-ddone", stage, `✓ ${label.replace(/[<>&]/g, "")} closed`);
  Object.assign(done.style, { left: `${home.x}px`, top: `${home.y - 48}px` });
  run(done, [{ opacity: 0, transform: "translate(-50%, 8px) scale(0.85)", offset: 0 }, { opacity: 0, transform: "translate(-50%, 8px) scale(0.85)", offset: off(1520) }, { opacity: 1, transform: "translate(-50%, 0) scale(1)", offset: off(1700), easing: ease }, { opacity: 0, transform: "translate(-50%, -10px)", offset: 1 }]);

  const t1 = window.setTimeout(() => haptic("tick", 0.7), 620);
  const t2 = window.setTimeout(() => haptic("tick", 0.4), 1150);
  const t3 = window.setTimeout(() => haptic("edge", 1), 1600);
  return finish(root, anims, T, () => [t1, t2, t3].forEach((t) => window.clearTimeout(t)));
}
