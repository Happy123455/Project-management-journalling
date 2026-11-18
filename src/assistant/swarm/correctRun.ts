import { changesOf, diffOps, summary, type Change, type Op, type Tok } from "./correct";
import { ARROW, node, swarmOff } from "./run";
import { haptic } from "../../lib/haptic";

/**
 * Plays a correction word by word (see correct.ts): an editor's arrow glides to each changed word,
 * a note says what kind of fix it is, deleted words are struck in red and fold away, new words
 * type in green, replaced words do both. Then a summary of every change (and the AI's reason).
 *
 * Over a paragraph in the note (`over`): the paragraph is hidden under a copy that shows the old
 * text turning into the new one, then the copy fades into the real paragraph. In a box of its
 * own (`into`, the ✨ Improve sheet): the box itself is filled. Finite Web Animations and CSS
 * transitions on a few throwaway nodes; nothing runs once it's over.
 */

const wait = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
const text = (ts: Tok[]) => ts.map((t) => t.w + t.sp).join("");
/** Long phrases wrap like normal text (no width animation, which needs them on one line). */
const WIDE = 6;

interface Built {
  /** Per op: the old part (del / rep) and the new part (ins / rep). */
  old: (HTMLElement | null)[];
  fresh: (HTMLElement | null)[];
  /** Per op: the unchanged words (spaced as before until the change next to them is made). */
  same: (Text | null)[];
}

function build(box: HTMLElement, ops: Op[]): Built {
  box.textContent = "";
  const old: (HTMLElement | null)[] = [];
  const fresh: (HTMLElement | null)[] = [];
  const same: (Text | null)[] = [];
  for (const op of ops) {
    if (op.kind === "same") {
      const t = document.createTextNode(text(op.a));
      box.append(t);
      old.push(null);
      fresh.push(null);
      same.push(t);
      continue;
    }
    same.push(null);
    const wide = Math.max(op.a.length, op.b.length) > WIDE ? " wide" : "";
    let o: HTMLElement | null = null;
    let f: HTMLElement | null = null;
    if (op.a.length) {
      o = document.createElement("span");
      o.className = `corr-old${wide}`;
      o.textContent = text(op.a);
      box.append(o);
    }
    if (op.b.length) {
      f = document.createElement("span");
      f.className = `corr-new${wide} hidden`;
      f.textContent = text(op.b);
      box.append(f);
    }
    old.push(o);
    fresh.push(f);
  }
  return { old, fresh, same };
}

const grow = (el: HTMLElement, ms: number) => {
  el.classList.remove("hidden");
  const a = el.classList.contains("wide")
    ? el.animate([{ opacity: 0, filter: "blur(3px)" }, { opacity: 1, filter: "blur(0)" }], { duration: ms, easing: "ease-out" })
    : el.animate([{ maxWidth: "0px", opacity: 0 }, { maxWidth: `${el.scrollWidth + 2}px`, opacity: 1 }], { duration: ms, easing: "cubic-bezier(0.22, 1, 0.36, 1)" });
  // Held unseen while the arrow came: the animation takes over from here.
  el.style.maxWidth = "";
  el.style.opacity = "";
  return a.finished.then(() => undefined, () => undefined);
};
const fold = async (el: HTMLElement, ms: number) => {
  const wide = el.classList.contains("wide");
  const w = el.getBoundingClientRect().width;
  await el.animate(wide ? [{ opacity: 1 }, { opacity: 0, filter: "blur(2px)" }] : [{ maxWidth: `${w + 2}px`, opacity: 1 }, { maxWidth: "0px", opacity: 0 }], { duration: ms, easing: "ease-in" }).finished.catch(() => undefined);
  el.classList.add("gone");
};

export interface CorrectOpts {
  /** The AI's own reason, shown with the summary. */
  why?: string;
  /** Who did it (the arrow's tag). */
  who?: string;
}

let playing = 0;

/** Over a block in the note. Resolves when it's over (at once when there's nothing to show). */
export function correctOver(el: HTMLElement, before: string, after: string, opts: CorrectOpts = {}): Promise<void> {
  if (swarmOff() || playing >= 2 || !el.isConnected || typeof el.animate !== "function") return Promise.resolve();
  const ops = diffOps(before, after);
  const changes = changesOf(ops);
  if (!changes.length) return Promise.resolve();
  const r = el.getBoundingClientRect();
  if (r.bottom < 0 || r.top > window.innerHeight) return Promise.resolve();
  const root = node("swarm swarm-correct", document.body);
  root.setAttribute("aria-hidden", "true");
  const stage = node("swarm-stage", root);
  const box = node("corr-box", stage);
  const cs = getComputedStyle(el);
  for (const k of ["fontFamily", "fontSize", "fontWeight", "fontStyle", "lineHeight", "letterSpacing", "wordSpacing", "color", "textAlign", "textTransform", "paddingTop", "paddingBottom", "paddingLeft", "paddingRight"] as const) box.style[k] = cs[k];
  Object.assign(box.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, minHeight: `${r.height}px` });
  // The real paragraph waits unseen under the copy.
  const hide = el.animate([{ opacity: 0 }, { opacity: 0 }], { duration: 120_000, fill: "both" });
  const top0 = r.top;
  const follow = () => {
    if (!el.isConnected) return;
    stage.style.transform = `translate3d(0, ${el.getBoundingClientRect().top - top0}px, 0)`;
  };
  window.addEventListener("scroll", follow, { capture: true, passive: true });
  playing++;
  return play(root, stage, box, ops, changes, opts)
    .then(async () => {
      // The copy fades into the real thing.
      el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 420, easing: "ease-out" });
      hide.cancel();
      await box.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 420, easing: "ease-out", fill: "forwards" }).finished.catch(() => undefined);
      await wait(1400);
    })
    .finally(() => {
      hide.cancel();
      window.removeEventListener("scroll", follow, { capture: true });
      root.remove();
      playing--;
    });
}

/** Inside a box of its own (it's filled with the text; it ends showing the new text). */
export function correctInto(box: HTMLElement, before: string, after: string, opts: CorrectOpts = {}): Promise<void> {
  const ops = diffOps(before, after);
  const changes = changesOf(ops);
  if (swarmOff() || !changes.length) {
    box.textContent = after;
    return Promise.resolve();
  }
  const root = node("swarm swarm-correct", document.body);
  root.setAttribute("aria-hidden", "true");
  const stage = node("swarm-stage", root);
  box.classList.add("corr-inline");
  return play(root, stage, box, ops, changes, opts)
    .then(() => wait(2000))
    .finally(() => {
      root.remove();
      box.classList.remove("corr-inline");
    });
}

async function play(root: HTMLElement, stage: HTMLElement, box: HTMLElement, ops: Op[], changes: Change[], opts: CorrectOpts) {
  const parts = build(box, ops);
  const alive = () => root.isConnected && box.isConnected;
  // Slower and more detailed for a few changes, brisker for many.
  const f = changes.length <= 3 ? 1 : changes.length <= 7 ? 0.82 : 0.6;
  const SHOWN = 14;

  const me = node("swarm-agent corr-agent", stage, `${ARROW}<span class="swarm-tag"><b>✎</b>${esc(opts.who ?? "Editor")}</span>`);
  me.style.setProperty("--h", "265");
  const tip = node("corr-tip", stage);
  const count = node("corr-count", stage);
  const b0 = box.getBoundingClientRect();
  let at = { x: b0.right + 30, y: b0.top - 30 };
  me.style.transform = `translate3d(${at.x}px, ${at.y}px, 0)`;
  me.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300, fill: "forwards" });
  Object.assign(count.style, { left: `${b0.left}px`, top: `${Math.max(8, b0.top - 30)}px` });
  count.textContent = `Checking… ${changes.length} change${changes.length === 1 ? "" : "s"}`;
  count.animate([{ opacity: 0, transform: "translateY(4px)" }, { opacity: 1, transform: "none" }], { duration: 300, fill: "forwards" });
  await wait(420 * f);

  const moveTo = async (x: number, y: number, ms: number) => {
    const from = at;
    at = { x, y };
    await me.animate([{ transform: `translate3d(${from.x}px, ${from.y}px, 0)` }, { transform: `translate3d(${x}px, ${y}px, 0)` }], { duration: ms, easing: "cubic-bezier(0.45, 0, 0.2, 1)", fill: "forwards" }).finished.catch(() => undefined);
  };
  const tell = (c: Change, n: number) => {
    tip.className = `corr-tip k-${c.kind}`;
    tip.innerHTML = `<b>${esc(c.label)}</b> <span>${esc(c.detail)}</span><i>${n}/${changes.length}</i>`;
    const tw = Math.min(300, window.innerWidth - 16);
    const left = Math.max(8, Math.min(window.innerWidth - tw - 8, at.x - 30));
    const below = at.y + 34 + 60 < window.innerHeight;
    Object.assign(tip.style, { left: `${left}px`, top: `${below ? at.y + 30 : at.y - 70}px`, maxWidth: `${tw}px` });
    tip.animate([{ opacity: 0, transform: "translateY(6px) scale(0.96)" }, { opacity: 1, transform: "none" }], { duration: 220 * f, easing: "ease-out", fill: "forwards" });
  };

  const applied = new Set<number>();
  for (let n = 0; n < changes.length && alive(); n++) {
    const c = changes[n];
    const o = parts.old[c.op];
    const nw = parts.fresh[c.op];
    const fast = n >= SHOWN;
    const g = fast ? 0.35 : f;
    // Aim at the old words, or (an insert) the spot where the new ones go.
    const aim = o ?? nw!;
    const ar = (() => {
      if (o) return o.getBoundingClientRect();
      // An empty insert has no box yet: aim at the end of what comes before it.
      nw!.style.opacity = "0";
      if (!nw!.classList.contains("wide")) nw!.style.maxWidth = "0px";
      nw!.classList.remove("hidden");
      return nw!.getBoundingClientRect();
    })();
    await moveTo(ar.left + Math.min(ar.width / 2, 24), ar.top + ar.height * 0.75, 460 * g);
    if (!alive()) break;
    if (!fast) {
      tell(c, n + 1);
      haptic("tick", 0.35);
    }
    aim.classList.add("aim");
    await wait(260 * g);
    if (c.kind === "del" && o) {
      o.classList.add("struck");
      await wait(340 * g);
      await fold(o, 380 * g);
    } else if (c.kind === "ins" && nw) {
      nw.classList.add("typed");
      // The arrow types along the new words as they come in.
      const grown = grow(nw, 460 * g);
      await wait(40);
      const r2 = nw.getBoundingClientRect();
      void moveTo(Math.max(r2.left, Math.min(r2.left + nw.scrollWidth, window.innerWidth - 20)), r2.top + r2.height * 0.75, 440 * g);
      await grown;
    } else if (o && nw) {
      o.classList.add("struck");
      await wait(320 * g);
      nw.classList.add("typed");
      await grow(nw, 420 * g);
      await fold(o, 320 * g);
    }
    aim.classList.remove("aim");
    // The words either side now sit as in the new text ("yesterday" loses its space before ",").
    applied.add(c.op);
    const settled = (k: number) => k < 0 || k >= ops.length || ops[k].kind === "same" || applied.has(k);
    for (const k of [c.op - 1, c.op + 1]) {
      const t = parts.same[k];
      if (t && settled(k - 1) && settled(k + 1)) t.data = text(ops[k].b);
    }
    if (!fast) await wait(280 * g);
  }
  if (!alive()) return;

  // All done: the summary, and the AI's reason when it gave one.
  tip.className = "corr-tip corr-sum";
  tip.innerHTML = `<b>✓ ${esc(summary(changes))}</b>${opts.why ? `<span>${esc(opts.why)}</span>` : ""}<span class="corr-key"><s>removed</s> <u>added</u> <em>replaced</em></span>`;
  const b1 = box.getBoundingClientRect();
  const tw = Math.min(320, window.innerWidth - 16);
  Object.assign(tip.style, { left: `${Math.max(8, Math.min(window.innerWidth - tw - 8, b1.left))}px`, top: `${Math.min(window.innerHeight - 110, b1.bottom + 8)}px`, maxWidth: `${tw}px` });
  tip.animate([{ opacity: 0, transform: "translateY(8px)" }, { opacity: 1, transform: "none" }], { duration: 320, easing: "ease-out", fill: "forwards" });
  count.textContent = `✓ Corrected`;
  haptic("edge", 0.6);
  void moveTo(b1.right + 40, b1.top - 40, 600);
  me.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 600, fill: "forwards" });
  await wait(1300);
  box.classList.add("settle");
  await wait(700);
}
