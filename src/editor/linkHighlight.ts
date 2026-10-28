import { Extension } from "@tiptap/react";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { TAG_RE, WIKILINK_RE } from "../lib/links";

function decorate(doc: PMNode): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    for (const m of node.text.matchAll(WIKILINK_RE)) {
      const from = pos + m.index;
      decorations.push(Decoration.inline(from, from + m[0].length, { class: "wikilink", "data-target": m[1].trim() }));
    }
    for (const m of node.text.matchAll(TAG_RE)) {
      const from = pos + m.index + m[1].length;
      decorations.push(Decoration.inline(from, from + m[2].length + 1, { class: "tag" }));
    }
  });
  return DecorationSet.create(doc, decorations);
}

/** Highlights [[wikilinks]] and #tags as you type, without changing the stored text. */
export const LinkHighlight = Extension.create({
  name: "linkHighlight",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("linkHighlight"),
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
