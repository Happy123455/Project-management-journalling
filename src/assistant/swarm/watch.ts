import { cursorFx } from "../AgentCursors";
import { atRate, swarmOff, swarmOn } from "./run";
import { demolish, type GoneBlock } from "./gone";
import { likeness } from "./correct";
import { correctOver } from "./correctRun";
import type { SwarmTask } from "./plan";

/**
 * Finds the blocks an agent just made, changed or deleted in the open note and plays the right show:
 *  - a paragraph it reworded or corrected: the word-by-word correction (correctRun.ts),
 *  - a block it deleted: the crew that strikes it through and sweeps it away (gone.ts),
 *  - anything new or rebuilt: the swarm that builds it (run.ts).
 * Before the tool runs, the note's top-level blocks are fingerprinted (and the ones on screen
 * copied, so a deleted one can still be shown); after it saves, the fingerprints that are new
 * are the blocks it touched and the ones that are missing are the blocks it removed.
 */

const editorRoot = () => document.querySelector<HTMLElement>(".editor .ProseMirror, .ProseMirror");
const print = (el: Element) => `${el.tagName}|${(el.className || "").toString().split(" ")[0]}|${el.textContent ?? ""}`;
const TEXTY = /^(P|H[1-6]|BLOCKQUOTE)$/;

interface Before {
  print: string;
  index: number;
  tag: string;
  text: string;
  /** Only for blocks on screen: how it looked and where. */
  gone?: GoneBlock;
}

function snapshot(pm: HTMLElement | null): Before[] {
  if (!pm) return [];
  const base = pm.getBoundingClientRect();
  return (Array.from(pm.children) as HTMLElement[]).map((el, index) => {
    const b: Before = { print: print(el), index, tag: el.tagName, text: el.textContent ?? "" };
    const r = el.getBoundingClientRect();
    if (r.bottom > 30 && r.top < window.innerHeight - 30 && r.height > 4)
      b.gone = { clone: el.cloneNode(true) as HTMLElement, index, top: r.top - base.top, left: r.left - base.left, width: r.width, height: r.height };
    return b;
  });
}

/** fast: a live agent's edit, shown at double speed. */
export function watchEdit(task: SwarmTask & { actor?: string; why?: string; fast?: boolean }) {
  if (swarmOff()) return () => undefined;
  const before = snapshot(editorRoot());
  /** Call once the tool is done. */
  return () => {
    let tries = 0;
    const look = () => {
      const now = editorRoot();
      if (!now) return;
      const left = new Map<string, number>();
      for (const b of before) left.set(b.print, (left.get(b.print) ?? 0) + 1);
      const fresh: HTMLElement[] = [];
      for (const k of now.children) {
        const p = print(k);
        const c = left.get(p) ?? 0;
        if (c > 0) left.set(p, c - 1);
        else if ((k.textContent ?? "").trim() || k.querySelector("img, video, canvas, svg, table, input")) fresh.push(k as HTMLElement);
      }
      // The blocks that went (the last ones with a missing fingerprint).
      const removed: Before[] = [];
      for (let i = before.length - 1; i >= 0; i--) {
        const b = before[i];
        const c = left.get(b.print) ?? 0;
        if (c > 0) {
          left.set(b.print, c - 1);
          removed.unshift(b);
        }
      }
      // Saved, but not drawn yet: look again a little later (a few times, then give up).
      if (!fresh.length && !removed.length) {
        if (++tries < 4) window.setTimeout(look, 180 * tries);
        return;
      }
      const onScreen = (e: HTMLElement) => {
        const r = e.getBoundingClientRect();
        return r.bottom > 40 && r.top < window.innerHeight - 40;
      };
      // A paragraph that came back changed (most of its words the same): a correction.
      const pairs: { el: HTMLElement; was: Before }[] = [];
      const builds: HTMLElement[] = [];
      for (const el of fresh) {
        let best: Before | null = null;
        let score = 0;
        if (TEXTY.test(el.tagName))
          for (const b of removed) {
            if (!TEXTY.test(b.tag) || pairs.some((p) => p.was === b)) continue;
            const s = likeness(b.text, el.textContent ?? "");
            if (s > score) (score = s), (best = b);
          }
        if (best && score >= 0.3) pairs.push({ el, was: best });
        else builds.push(el);
      }
      const deleted = removed.filter((b) => b.gone && !pairs.some((p) => p.was === b));
      const shown = pairs.filter((p) => onScreen(p.el)).length + builds.filter(onScreen).length + deleted.length;
      // The agent's arrows go back to its bubble while the show plays.
      if (shown && task.actor) cursorFx({ key: task.actor, phase: "think", soft: true });
      const who = task.actor ?? "Agent";
      atRate(task.fast ? 2.2 : 1, () => {
        for (const p of pairs.filter((x) => onScreen(x.el)).slice(0, 2)) void correctOver(p.el, p.was.text, p.el.textContent ?? "", { why: task.why, who: `Editor · ${who}` });
        for (const b of deleted.slice(0, 2)) void demolish(now, b.gone!, who);
        for (const el of builds.filter(onScreen).slice(-2)) void swarmOn(el, task);
      });
    };
    window.setTimeout(look, 140);
  };
}
