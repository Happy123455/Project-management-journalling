import { Extension } from "@tiptap/react";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { Node as PMNode } from "@tiptap/pm/model";
import { REMOTE } from "../sync/liveTyping";

/** Text blocks that remember when they were started. */
export const BORN_TYPES = ["paragraph", "heading"];
const key = new PluginKey("blockBorn");

/** The text block around `pos`, with its position. */
function textblockAt(doc: PMNode, pos: number): { node: PMNode; pos: number } | null {
  const $pos = doc.resolve(Math.min(Math.max(0, pos), doc.content.size));
  for (let d = $pos.depth; d > 0; d--) {
    const node = $pos.node(d);
    if (node.isTextblock) return { node, pos: $pos.before(d) };
  }
  return null;
}

/**
 * Every line remembers the moment typing in it began (`born`, a time stored on the block, so it
 * syncs with the note but isn't in its text). Entries' Table view shows that time for an entry
 * that has no timestamp written in it. Only typing by hand counts: not loading, syncing, AI edits
 * or undo; and a line keeps its first time when it's edited later.
 */
export const BlockBorn = Extension.create({
  name: "blockBorn",
  addGlobalAttributes() {
    return [
      {
        types: BORN_TYPES,
        attributes: {
          born: {
            default: null,
            keepOnSplit: false,
            parseHTML: (el) => el.getAttribute("data-born"),
            renderHTML: (attrs) => (attrs.born ? { "data-born": attrs.born } : {}),
          },
        },
      },
    ];
  },
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key,
        appendTransaction: (trs, oldState, state) => {
          const typed = trs.some(
            (tr) => tr.docChanged && !tr.getMeta(REMOTE) && !tr.getMeta("aiActor") && !tr.getMeta("history$") && tr.getMeta("addToHistory") !== false && !tr.getMeta(key),
          );
          if (!typed || !state.selection.empty) return null;
          const here = textblockAt(state.doc, state.selection.head);
          if (!here || here.node.attrs.born || !BORN_TYPES.includes(here.node.type.name) || !here.node.textContent.trim()) return null;
          // Only when this line was empty a moment ago (typing in it just began).
          const back = trs.reduceRight((p, tr) => tr.mapping.invert().map(p), state.selection.head);
          const before = textblockAt(oldState.doc, back);
          if (before && before.node.textContent.trim() && before.node.type === here.node.type) return null;
          return state.tr.setNodeAttribute(here.pos, "born", new Date().toISOString()).setMeta(key, true).setMeta("addToHistory", false);
        },
      }),
    ];
  },
});
