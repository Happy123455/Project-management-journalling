import { Extension } from "@tiptap/react";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { TAG_RE, WIKILINK_RE } from "../lib/links";
import { isDayTarget, isNoteEmbed, splitTarget } from "../lib/noteLinks";
import { mountNoteEmbed } from "./noteEmbed";

/** Embed widgets, kept by target so typing elsewhere doesn't draw them again. */
const embedWidgets = new WeakMap<HTMLElement, () => void>();
function embedWidget(target: string, at: number, n: number) {
  return Decoration.widget(
    at,
    () => {
      const { dom, destroy } = mountNoteEmbed(target);
      embedWidgets.set(dom, destroy);
      return dom;
    },
    {
      side: 1,
      key: `note-embed:${target}:${n}`,
      ignoreSelection: true,
      // Taps and scrolls in the preview belong to it, not to the text around it.
      stopEvent: () => true,
      destroy: (dom) => {
        embedWidgets.get(dom as HTMLElement)?.();
      },
    },
  );
}

interface Highlights {
  set: DecorationSet;
  /** Where each [[link]] is, to hide its brackets while the cursor is elsewhere. */
  links: [number, number, boolean?][];
}

function decorate(doc: PMNode): Highlights {
  const decorations: Decoration[] = [];
  const links: [number, number, boolean?][] = [];
  let embeds = 0;
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    for (const m of node.text.matchAll(WIKILINK_RE)) {
      const from = pos + m.index;
      const target = m[1].trim();
      const day = isDayTarget(splitTarget(target).note);
      decorations.push(Decoration.inline(from, from + m[0].length, { class: day ? "wikilink daylink" : "wikilink", "data-target": target }));
      const bang = m.index > 0 && node.text[m.index - 1] === "!";
      links.push([from, from + m[0].length, bang]);
      // ![[Note]] / ![[2026-11-03#Part]]: the note shown right under it.
      if (m.index > 0 && node.text[m.index - 1] === "!" && isNoteEmbed(target)) decorations.push(embedWidget(target, from + m[0].length, embeds++));
    }
    for (const m of node.text.matchAll(TAG_RE)) {
      const from = pos + m.index + m[1].length;
      decorations.push(Decoration.inline(from, from + m[2].length + 1, { class: "tag" }));
    }
  });
  return { set: DecorationSet.create(doc, decorations), links };
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
      new Plugin<Highlights>({
        key: new PluginKey("linkHighlight"),
        state: {
          init: (_, { doc }) => decorate(doc),
          apply: (tr, old) => (tr.docChanged ? decorate(tr.doc) : old),
        },
        props: {
          // Like Obsidian: a link shows without its [[ ]] unless the cursor is in it or right beside it.
          decorations(state) {
            const { set, links } = this.getState(state)!;
            const { from, to } = state.selection;
            const hide = links
              .filter(([a, b, bang]) => to < (bang ? a - 1 : a) || from > b)
              .flatMap(([a, b, bang]) => [Decoration.inline(bang ? a - 1 : a, a + 2, { class: "wl-bracket" }), Decoration.inline(b - 2, b, { class: "wl-bracket" })]);
            return hide.length ? set.add(state.doc, hide) : set;
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
