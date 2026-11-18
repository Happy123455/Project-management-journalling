import { cursorFx } from "../AgentCursors";
import { swarmOff, swarmOn } from "./run";
import type { SwarmTask } from "./plan";

/**
 * Finds the block an agent just made or changed in the open note and plays the swarm on it.
 * Before the tool runs, the note's top-level blocks are fingerprinted; after it saves, the blocks
 * whose fingerprint is new are the ones it touched. Works for any tool and any kind of block.
 */

const editorRoot = () => document.querySelector<HTMLElement>(".editor .ProseMirror, .ProseMirror");
const print = (el: Element) => `${el.tagName}|${(el.className || "").toString().split(" ")[0]}|${el.textContent ?? ""}`;

export function watchEdit(task: SwarmTask & { actor?: string }) {
  if (swarmOff()) return () => undefined;
  const pm = editorRoot();
  const before = new Map<string, number>();
  for (const k of pm?.children ?? []) before.set(print(k), (before.get(print(k)) ?? 0) + 1);
  /** Call once the tool is done. */
  return () => {
    let tries = 0;
    const look = () => {
      const now = editorRoot();
      if (!now) return;
      const left = new Map(before);
      const fresh: HTMLElement[] = [];
      for (const k of now.children) {
        const p = print(k);
        const c = left.get(p) ?? 0;
        if (c > 0) left.set(p, c - 1);
        else if ((k.textContent ?? "").trim() || k.querySelector("img, video, canvas, svg, table, input")) fresh.push(k as HTMLElement);
      }
      // Saved, but not drawn yet: look again a little later (a few times, then give up).
      if (!fresh.length) {
        if (++tries < 4) window.setTimeout(look, 180 * tries);
        return;
      }
      const onScreen = fresh.filter((e) => {
        const r = e.getBoundingClientRect();
        return r.bottom > 40 && r.top < window.innerHeight - 40;
      });
      // The agent's arrows go back to its bubble while the swarm builds.
      if (onScreen.length && task.actor) cursorFx({ key: task.actor, phase: "think" });
      for (const el of onScreen.slice(-2)) void swarmOn(el, task);
    };
    window.setTimeout(look, 140);
  };
}
