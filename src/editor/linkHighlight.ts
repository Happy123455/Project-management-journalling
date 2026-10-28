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

export interface LinkHighlightOptions {
  onOpenLink: (target: string) => void;
  onOpenTag: (tag: string) => void;
}

/** Highlights [[wikilinks]] and #tags as you type, and opens them on tap; the stored text is unchanged. */
export const LinkHighlight = Extension.create<LinkHighlightOptions>({
  name: "linkHighlight",
  addOptions() {
    return { onOpenLink: () => {}, onOpenTag: () => {} };
  },
  addProseMirrorPlugins() {
    const options = this.options;
    // The link under the finger when the press starts. The first tap also focuses the editor,
    // which shrinks the calendar and moves the text, so by the click the link may have moved away.
    let pressed: { kind: "link" | "tag"; value: string } | null = null;
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
          handleDOMEvents: {
            pointerdown(_view, event) {
              const el = (event.target as HTMLElement).closest?.(".wikilink, .tag");
              pressed = !el
                ? null
                : el.classList.contains("wikilink")
                  ? { kind: "link", value: el.getAttribute("data-target") ?? "" }
                  : { kind: "tag", value: (el.textContent ?? "").replace(/^#/, "") };
              return false;
            },
          },
          handleClick() {
            const target = pressed;
            pressed = null;
            if (!target) return false;
            if (target.kind === "link") options.onOpenLink(target.value);
            else options.onOpenTag(target.value);
            return true;
          },
        },
      }),
    ];
  },
});
