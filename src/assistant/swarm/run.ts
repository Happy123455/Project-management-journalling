import { planSwarm, rng, type PieceHint, type SwarmPlan, type SwarmTask } from "./plan";

/**
 * Plays the swarm over a block on screen (see plan.ts). All of it is Web Animations on a few
 * fixed elements (transform/opacity, done by the compositor): no frame loop, no React state.
 * When it ends every node is removed and the block is left exactly as the editor drew it.
 * The block itself is only animated (never given a style or class), so ProseMirror sees no change.
 */

interface Piece {
  hint: PieceHint;
  /** Relative to the block's box. */
  x: number;
  y: number;
  w: number;
  h: number;
}

const MAX_PIECES = 14;
const running = new WeakSet<Element>();
let live = 0;

export function swarmOff(): boolean {
  try {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return true;
    return localStorage.getItem("journal.swarm") === "off";
  } catch {
    return false;
  }
}

const HINTS: [string, PieceHint][] = [
  ["th", "head"],
  ["td", "cell"],
  [".math-render", "formula"],
  [".math-lines li", "line"],
  [".math-result", "result"],
  ["canvas, svg:not(.katex svg)", "plot"],
  ["img, video", "media"],
  ["h1, h2, h3, .dl-title, .link-title", "head"],
  ["input[type=checkbox], li[data-type=taskItem] > label", "check"],
  ["button, .dl-bar, .math-vars, .sheet-tabs", "box"],
];

function lineRects(el: Element, base: DOMRect, hint: PieceHint): Piece[] {
  const range = document.createRange();
  range.selectNodeContents(el);
  const out: Piece[] = [];
  for (const r of range.getClientRects()) {
    if (r.width < 6 || r.height < 6) continue;
    const last = out[out.length - 1];
    // One piece per line (the text is many small boxes).
    if (last && Math.abs(last.y + base.top - r.top) < r.height / 2) {
      const right = Math.max(last.x + last.w, r.right - base.left);
      last.x = Math.min(last.x, r.left - base.left);
      last.w = right - last.x;
      continue;
    }
    out.push({ hint, x: r.left - base.left, y: r.top - base.top, w: r.width, h: r.height });
  }
  range.detach?.();
  return out;
}

/** The parts the finished block is made of, as they sit on screen. */
export function piecesOf(el: HTMLElement): Piece[] {
  const base = el.getBoundingClientRect();
  const tag = el.tagName;
  let out: Piece[] = [];
  if (/^(P|H[1-6]|BLOCKQUOTE)$/.test(tag)) out = lineRects(el, base, /^H/.test(tag) ? "head" : "line");
  else if (/^(UL|OL)$/.test(tag)) {
    for (const li of el.querySelectorAll(":scope > li")) {
      const box = li.querySelector("input[type=checkbox], label");
      if (box) {
        const r = box.getBoundingClientRect();
        if (r.width) out.push({ hint: "check", x: r.left - base.left, y: r.top - base.top, w: r.width, h: r.height });
      }
      const body = li.querySelector(":scope > div, :scope > p") ?? li;
      out.push(...lineRects(body, base, "line"));
    }
  } else if (el.querySelector("pre")) out = lineRects(el.querySelector("pre")!, base, "line");
  else {
    const seen: Element[] = [];
    for (const [sel, hint] of HINTS) {
      for (const p of el.querySelectorAll(sel)) {
        if (seen.some((s) => s.contains(p) || p.contains(s))) continue;
        const r = p.getBoundingClientRect();
        if (r.width < 8 || r.height < 8 || r.bottom < base.top || r.top > base.bottom) continue;
        seen.push(p);
        out.push({ hint, x: r.left - base.left, y: r.top - base.top, w: r.width, h: r.height });
      }
    }
  }
  if (out.length > MAX_PIECES) {
    const step = out.length / MAX_PIECES;
    out = Array.from({ length: MAX_PIECES }, (_, i) => out[Math.floor(i * step)]);
  }
  if (out.length < 2) {
    // Nothing to pick apart (one picture, an empty box): build it as a few soft slabs.
    const w = base.width;
    const h = base.height;
    const one = out[0]?.hint ?? "box";
    out = h > 60
      ? [
          { hint: one, x: 0, y: 0, w, h: h * 0.62 },
          { hint: "line", x: 0, y: h * 0.68, w: w * 0.7, h: h * 0.14 },
          { hint: "box", x: w * 0.74, y: h * 0.68, w: w * 0.26, h: h * 0.14 },
        ]
      : [
          { hint: one === "box" ? "line" : one, x: 0, y: 0, w: w * 0.6, h },
          { hint: "line", x: w * 0.62, y: 0, w: w * 0.38, h },
        ];
  }
  return out;
}

const ARROW = '<svg viewBox="0 0 24 24" width="20" height="20"><path d="M4 2 L4 19 L8.6 14.8 L11.6 21.6 L14.6 20.3 L11.7 13.6 L18 13.4 Z"/></svg>';

function node(cls: string, parent: HTMLElement, html = "") {
  const d = document.createElement("div");
  d.className = cls;
  if (html) d.innerHTML = html;
  parent.appendChild(d);
  return d;
}

const ease = "cubic-bezier(0.22, 1, 0.36, 1)";

/**
 * Builds `el` in front of the person with a swarm of agents, then morphs into the real block.
 * Resolves when it's over (at once when it can't or shouldn't run).
 */
export function swarmOn(el: HTMLElement | null | undefined, task: SwarmTask = {}, seed = Date.now()): Promise<void> {
  if (!el || !el.isConnected || running.has(el) || live >= 2 || swarmOff() || typeof el.animate !== "function") return Promise.resolve();
  const box = el.getBoundingClientRect();
  if (box.width < 20 || box.height < 8 || box.bottom < 0 || box.top > window.innerHeight) return Promise.resolve();
  const pieces = piecesOf(el);
  const plan = planSwarm({ ...task, shape: task.shape ?? `${el.tagName} ${el.className}` }, pieces.map((p) => p.hint), rng(seed));
  running.add(el);
  live++;
  return play(el, box, pieces, plan).finally(() => {
    running.delete(el);
    live--;
  });
}

function play(el: HTMLElement, box: DOMRect, pieces: Piece[], plan: SwarmPlan): Promise<void> {
  const T = plan.totalMs;
  const off = (ms: number) => Math.min(1, Math.max(0, ms / T));
  const root = node(`swarm swarm-${plan.kind}`, document.body);
  root.setAttribute("aria-hidden", "true");
  const stage = node("swarm-stage", root);
  const frame = node("swarm-frame", stage);
  const radius = getComputedStyle(el).borderRadius;
  Object.assign(frame.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px`, borderRadius: radius && radius !== "0px" ? radius : "" });
  const anims: Animation[] = [];
  const run = (n: Element, k: Keyframe[], o: KeyframeAnimationOptions) => anims.push(n.animate(k, { duration: T, fill: "both", ...o }));

  // The real block waits unseen, then comes out of the build.
  const b = off(plan.buildMs);
  run(el, [{ opacity: 0, offset: 0 }, { opacity: 0, filter: "blur(6px)", transform: "scale(0.97)", offset: b }, { opacity: 1, filter: "blur(0px)", transform: "none", offset: 1 }], { fill: "none", easing: "linear" });
  run(frame, [{ opacity: 0, transform: "scale(0.94)", offset: 0 }, { opacity: 1, transform: "scale(1)", offset: off(plan.enterMs), easing: ease }, { opacity: 1, offset: b }, { opacity: 0, transform: "scale(1.015)", offset: 1 }], { easing: "linear" });

  // Parts start as faint dashed ghosts and fill in when an agent works on them.
  const firstAt = new Map<number, { at: number; dur: number; act: string }>();
  for (const s of plan.steps) if (!firstAt.has(s.piece)) firstAt.set(s.piece, s);
  pieces.forEach((p, i) => {
    const d = node(`swarm-piece sp-${p.hint}`, frame);
    Object.assign(d.style, { left: `${p.x}px`, top: `${p.y}px`, width: `${p.w}px`, height: `${p.h}px` });
    const s = firstAt.get(i);
    const at = s?.at ?? plan.enterMs;
    const end = at + (s?.dur ?? 300);
    const from: Keyframe =
      s?.act === "type" ? { clipPath: "inset(0 100% 0 0 round 6px)", opacity: 0.9 } : s?.act === "draw" ? { transform: "scaleY(0.05)", opacity: 0.9 } : s?.act === "drag" ? { transform: "translate(-18px, 14px) scale(0.9)", opacity: 0 } : { transform: "scale(0.55)", opacity: 0 };
    const done: Keyframe = s?.act === "type" ? { clipPath: "inset(0 0% 0 0 round 6px)", opacity: 1 } : { transform: "none", opacity: 1 };
    const o1 = Math.min(off(at), b);
    const o2 = Math.min(Math.max(off(end), o1), b);
    run(d, [{ ...from, offset: 0 }, { ...from, offset: o1 }, { ...done, offset: o2, easing: s?.act === "click" ? "cubic-bezier(0.34, 1.56, 0.64, 1)" : ease }, { ...done, offset: b }, { opacity: 0, filter: "blur(3px)", offset: Math.min(1, b + (1 - b) * 0.8) }, { opacity: 0, offset: 1 }], { easing: "linear" });
  });

  // The agents: in from the edges together, to each part in turn, then out again.
  const W = window.innerWidth;
  const H = window.innerHeight;
  for (const a of plan.agents) {
    const me = node(`swarm-agent sa-${a.id}`, stage, `${ARROW}<span class="swarm-tag"><b>${a.icon}</b>${a.role}</span>`);
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
    const mine = plan.steps.filter((s) => s.agent === a.id);
    // Arrive near the first part it'll work on (or the block's middle).
    const p0 = mine[0] ? pieces[mine[0].piece] : null;
    at(plan.enterMs, box.left + (p0 ? p0.x + p0.w / 2 : box.width / 2), box.top + (p0 ? p0.y + p0.h / 2 : box.height / 2));
    for (const s of mine) {
      const p = pieces[s.piece];
      const x0 = box.left + p.x;
      const y = box.top + p.y + Math.min(p.h, 28) * 0.7;
      if (s.act === "type") {
        at(s.at, x0 + 4, y);
        at(s.at + s.dur, x0 + Math.max(10, p.w - 6), y, "linear");
      } else if (s.act === "draw") {
        at(s.at, x0 + p.w * 0.5, box.top + p.y + p.h - 4);
        at(s.at + s.dur, x0 + p.w * 0.5, box.top + p.y + 6, "ease-in-out");
      } else {
        at(s.at, x0 + Math.min(p.w * 0.5, 40), y);
        at(s.at + s.dur, x0 + Math.min(p.w * 0.5, 40) + 3, y + 2, "ease-out");
      }
      // Ripple where it clicks (every act starts with a click on the part).
      const rp = node("swarm-ripple", stage);
      rp.style.setProperty("--h", String(a.hue));
      Object.assign(rp.style, { left: `${x0 + (s.act === "type" ? 4 : s.act === "draw" ? p.w * 0.5 : Math.min(p.w * 0.5, 40))}px`, top: `${s.act === "draw" ? box.top + p.y + p.h - 4 : y}px` });
      run(rp, [{ transform: "scale(0.2)", opacity: 0, offset: 0 }, { transform: "scale(0.2)", opacity: 0.9, offset: off(s.at) }, { transform: "scale(2.4)", opacity: 0, offset: off(s.at + 520), easing: "ease-out" }, { opacity: 0, offset: 1 }], { easing: "linear" });
    }
    // Hand over: all gather on the block, then fly away while it morphs.
    const cx = box.left + box.width * (0.3 + (a.id % 3) * 0.2);
    const cy = box.top + Math.min(box.height * 0.5, 40);
    at(plan.buildMs - 60, cx, cy);
    k.push({ transform: `translate3d(${cx + (start.x - cx) * 0.6}px, ${cy + (start.y - cy) * 0.6}px, 0) scale(0.8)`, offset: 1, easing: "ease-in" });
    run(me, k, { easing: "linear" });
    run(me, [{ opacity: 0, offset: 0 }, { opacity: 1, offset: off(160) }, { opacity: 1, offset: b }, { opacity: 0, offset: 1 }], { easing: "linear" });
  }

  // The page may scroll under it: the stage follows the block (only while it runs).
  const follow = () => {
    if (!el.isConnected) return;
    const r = el.getBoundingClientRect();
    stage.style.transform = `translate3d(${r.left - box.left}px, ${r.top - box.top}px, 0)`;
  };
  window.addEventListener("scroll", follow, { capture: true, passive: true });

  return new Promise<void>((resolve) => {
    let over = false;
    const end = () => {
      if (over) return;
      over = true;
      window.removeEventListener("scroll", follow, { capture: true });
      for (const an of anims) an.cancel();
      root.remove();
      resolve();
    };
    anims[0].finished.then(end, end);
    // In case the block is redrawn mid-way (its animation then never ends).
    window.setTimeout(end, T + 200);
  });
}
