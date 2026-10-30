import { Extension } from "@tiptap/react";
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { skyFor } from "../lib/sky";
import { TIMESTAMP_RE } from "../lib/timestamp";

const LONG_PRESS_MS = 450;

/** The pill shown in place of a timestamp: sky colour, icon and "10:55"; hover or long-press shows it in full. */
function chip(full: string, hour: string, minute: string): HTMLElement {
  const sky = skyFor(Number(hour));
  const el = document.createElement("span");
  el.className = `ts-chip ts-${sky.phase}`;
  el.contentEditable = "false";
  el.style.setProperty("--sky", sky.bg);
  el.style.setProperty("--sky-fg", sky.fg);
  el.title = full;
  const short = `${sky.icon} ${hour}:${minute}`;
  el.textContent = short;

  const show = (expanded: boolean) => {
    el.textContent = expanded ? `${sky.icon} ${full}` : short;
    el.classList.toggle("expanded", expanded);
  };
  el.addEventListener("mouseenter", () => show(true));
  el.addEventListener("mouseleave", () => show(false));

  let timer: number | undefined;
  el.addEventListener("touchstart", () => {
    timer = window.setTimeout(() => show(!el.classList.contains("expanded")), LONG_PRESS_MS);
  }, { passive: true });
  const cancel = () => window.clearTimeout(timer);
  el.addEventListener("touchend", (e) => {
    cancel();
    e.preventDefault();
  });
  el.addEventListener("touchmove", cancel, { passive: true });
  el.addEventListener("contextmenu", (e) => e.preventDefault());
  return el;
}

/** Chips for the timestamps in `node` (the whole doc, or one paragraph starting at `start`). */
function chipsIn(node: PMNode, start: number, out: Decoration[]) {
  node.descendants((child, pos) => {
    if (!child.isText || !child.text) return;
    for (const m of child.text.matchAll(TIMESTAMP_RE)) {
      const from = start + pos + m.index;
      const [full, , , , , hour, minute] = m;
      out.push(
        // The chip handles its own touches: the editor doesn't move the cursor or open the keyboard.
        Decoration.widget(from, () => chip(full, hour, minute), { side: -1, key: `ts:${full}`, ignoreSelection: true, stopEvent: () => true }),
        Decoration.inline(from, from + full.length, { class: "ts-raw" }),
      );
    }
  });
}

function decorate(doc: PMNode): DecorationSet {
  const decorations: Decoration[] = [];
  chipsIn(doc, 0, decorations);
  return DecorationSet.create(doc, decorations);
}

/**
 * After an edit, only the paragraphs it touched are searched again (not the whole note on every
 * letter typed); the other chips just move along.
 */
function redecorate(tr: Transaction, old: DecorationSet): DecorationSet {
  let set = old.map(tr.mapping, tr.doc);
  const blocks = new Map<number, PMNode>();
  tr.mapping.maps.forEach((map, i) => {
    map.forEach((_a, _b, newStart, newEnd) => {
      const rest = tr.mapping.slice(i + 1);
      const from = Math.min(rest.map(newStart, -1), tr.doc.content.size);
      const to = Math.min(rest.map(newEnd, 1), tr.doc.content.size);
      tr.doc.nodesBetween(from, to, (node, pos) => {
        if (!node.isTextblock) return true;
        blocks.set(pos, node);
        return false;
      });
    });
  });
  if (blocks.size > 50) return decorate(tr.doc);
  const fresh: Decoration[] = [];
  for (const [pos, node] of blocks) {
    set = set.remove(set.find(pos, pos + node.nodeSize));
    chipsIn(node, pos + 1, fresh);
  }
  return set.add(tr.doc, fresh);
}

/** Shows timestamps as sky-coloured chips. Only a display decoration: the stored text is unchanged. */
export const TimestampChip = Extension.create({
  name: "timestampChip",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("timestampChip"),
        state: {
          init: (_, { doc }) => decorate(doc),
          apply: (tr, old) => (tr.docChanged ? redecorate(tr, old) : old),
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
