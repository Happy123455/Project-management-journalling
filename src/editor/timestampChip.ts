import { Extension } from "@tiptap/react";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Decoration } from "@tiptap/pm/view";
import { decorateAll, redecorate } from "./textblockDecos";
import { skyForStamp } from "../lib/sky";
import { TIMESTAMP_RE } from "../lib/timestamp";

/** Marks a timestamp the app added because an older day was edited. */
export const EDIT_MARK = "✎ ";

/** The pill shown in place of a timestamp: sky colour, icon and "10:55"; hover or a tap shows it in full. */
function chip(full: string, date: { day: string; month: string; year: string }, hour: string, minute: string, edit?: { day: string; month: string }): HTMLElement {
  // The sky of that day and minute where the journal is (real sunrise/sunset, so it follows the seasons).
  const sky = skyForStamp(date.day, date.month, date.year, hour, minute);
  const el = document.createElement("span");
  el.className = edit ? `ts-chip ts-edit ts-${sky.phase}` : `ts-chip ts-${sky.phase}`;
  el.contentEditable = "false";
  el.style.setProperty("--sky", sky.bg);
  el.style.setProperty("--sky-fg", sky.fg);
  el.title = edit ? `Edited ${full}` : full;
  // An edit stamp on an older day says which day the edit was made: "✎ 31 Oct, 16:06".
  const short = edit ? `✎ ${edit.day} ${edit.month.slice(0, 3)}, ${hour}:${minute}` : `${sky.icon} ${hour}:${minute}`;
  el.textContent = short;

  const show = (expanded: boolean) => {
    el.textContent = expanded ? (edit ? `✎ Edited ${full}` : `${sky.icon} ${full}`) : short;
    el.classList.toggle("expanded", expanded);
  };
  // Mouse: hover shows it in full. Touch: a tap opens or closes it (the phone fakes hovers on tap,
  // which opened and closed it in the same moment, so those are ignored).
  el.addEventListener("pointerenter", (e) => e.pointerType === "mouse" && show(true));
  el.addEventListener("pointerleave", (e) => e.pointerType === "mouse" && show(false));

  let start: { x: number; y: number } | null = null;
  el.addEventListener("touchstart", (e) => {
    start = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  }, { passive: true });
  el.addEventListener("touchmove", (e) => {
    if (start && Math.hypot(e.touches[0].clientX - start.x, e.touches[0].clientY - start.y) > 10) start = null;
  }, { passive: true });
  el.addEventListener("touchend", (e) => {
    e.preventDefault();
    if (start) show(!el.classList.contains("expanded"));
    start = null;
  });
  el.addEventListener("contextmenu", (e) => e.preventDefault());
  return el;
}

/** Chips for the timestamps in `node` (the whole doc, or one paragraph starting at `start`). */
export function chipsIn(node: PMNode, start: number, out: Decoration[]) {
  node.descendants((child, pos) => {
    if (!child.isText || !child.text) return;
    for (const m of child.text.matchAll(TIMESTAMP_RE)) {
      const [full, day, month, year, , hour, minute] = m;
      // "✎ " right before it: an automatic stamp from editing an older day.
      const edit = child.text.slice(Math.max(0, m.index - EDIT_MARK.length), m.index) === EDIT_MARK;
      const from = start + pos + m.index - (edit ? EDIT_MARK.length : 0);
      const length = full.length + (edit ? EDIT_MARK.length : 0);
      out.push(
        // The chip handles its own touches: the editor doesn't move the cursor or open the keyboard.
        Decoration.widget(from, () => chip(full, { day, month, year }, hour, minute, edit ? { day, month } : undefined), { side: -1, key: `ts:${edit ? "e" : ""}${full}`, ignoreSelection: true, stopEvent: () => true }),
        Decoration.inline(from, from + length, { class: "ts-raw" }),
      );
    }
  });
}

/** Shows timestamps as sky-coloured chips. Only a display decoration: the stored text is unchanged. */
export const TimestampChip = Extension.create({
  name: "timestampChip",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("timestampChip"),
        state: {
          init: (_, { doc }) => decorateAll(doc, chipsIn),
          // Only the paragraphs an edit touched are searched again; the other chips move along.
          apply: (tr, old) => redecorate(tr, old, chipsIn),
        },
        props: {
          decorations(state) {
            return this.getState(state);
          },
        },
      }),
    ];
  },
});
