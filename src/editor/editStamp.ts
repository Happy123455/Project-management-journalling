import { Extension } from "@tiptap/react";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { Node as PMNode } from "@tiptap/pm/model";
import { editorPrefs } from "../lib/editorPrefs";
import { formatTimestamp } from "../lib/timestamp";
import { EDIT_MARK } from "./timestampChip";

/** Today's date part of a timestamp ("31,October,2026"), to tell if a line already has today's stamp. */
const todayPart = (now: Date) => formatTimestamp(now).split(" ")[0];

/** The innermost text block (paragraph, heading, list item text) around `pos`, with its position. */
function textblockAt(doc: PMNode, pos: number): { node: PMNode; start: number } | null {
  const $pos = doc.resolve(Math.min(Math.max(0, pos), doc.content.size));
  for (let d = $pos.depth; d > 0; d--) {
    const node = $pos.node(d);
    if (node.isTextblock) return { node, start: $pos.start(d) };
  }
  return null;
}

/**
 * Writing in an older day stamps the line once with when it was written: "✎ 31,October,2026
 * Saturday (16:06:12)", shown as a small "✎ 31 Oct, 16:06" chip (tap for the full time). Stored as
 * plain text, so it syncs and reads like any timestamp. Code blocks are left alone.
 */
export const EditStamp = Extension.create<{ isPastDay: () => boolean }>({
  name: "editStamp",
  addOptions() {
    return { isPastDay: () => false };
  },
  addProseMirrorPlugins() {
    const isPast = () => this.options.isPastDay();
    return [
      new Plugin({
        key: new PluginKey("editStamp"),
        appendTransaction: (transactions, oldState, newState) => {
          if (!isPast() || !editorPrefs().editStamps) return null;
          // Only typing and pasting by hand: not loads, AI edits, stamps themselves, or undo.
          const typed = transactions.some((tr) => tr.docChanged && !tr.getMeta("editStamp") && !tr.getMeta("history$") && !tr.getMeta("aiActor") && tr.getMeta("addToHistory") !== false);
          if (!typed || !newState.selection.empty) return null;
          const here = textblockAt(newState.doc, newState.selection.head);
          if (!here || here.node.type.spec.code) return null;
          const text = here.node.textContent;
          if (!text.trim()) return null;
          const now = new Date();
          if (text.includes(`${EDIT_MARK}${todayPart(now)}`)) return null;
          // Did this line's text change? (Folding, Day numbers and other attribute changes don't count.)
          const before = textblockAt(oldState.doc, transactions.reduceRight((p, tr) => tr.mapping.invert().map(p), newState.selection.head));
          if (before && before.node.textContent === text) return null;
          const stamp = `${EDIT_MARK}${formatTimestamp(now)} `;
          return newState.tr.insertText(stamp, here.start).setMeta("editStamp", true);
        },
      }),
    ];
  },
});
