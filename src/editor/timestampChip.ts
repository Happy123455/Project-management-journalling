import { Extension } from "@tiptap/react";
import { Plugin, PluginKey } from "@tiptap/pm/state";
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
  el.addEventListener("touchend", cancel);
  el.addEventListener("touchmove", cancel, { passive: true });
  el.addEventListener("contextmenu", (e) => e.preventDefault());
  return el;
}

function decorate(doc: PMNode): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    for (const m of node.text.matchAll(TIMESTAMP_RE)) {
      const from = pos + m.index;
      const [full, , , , , hour, minute] = m;
      decorations.push(
        Decoration.widget(from, () => chip(full, hour, minute), { side: -1, key: `ts:${full}`, ignoreSelection: true }),
        Decoration.inline(from, from + full.length, { class: "ts-raw" }),
      );
    }
  });
  return DecorationSet.create(doc, decorations);
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
          apply: (tr, old) => (tr.docChanged ? decorate(tr.doc) : old),
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
