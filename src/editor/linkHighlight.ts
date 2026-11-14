import { Extension } from "@tiptap/react";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Decoration, type DecorationSet } from "@tiptap/pm/view";
import { decorateAll, redecorate } from "./textblockDecos";
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

/** Marks a [[link]]'s decoration, with whether it's a ![[embed]] (the ! hides with the brackets). */
interface LinkSpec {
  wl: true;
  bang: boolean;
}
const BRACKET = { wlBracket: true };

/**
 * Links and tags in one paragraph. The brackets of every [[link]] are hidden by default (like
 * Obsidian); the link with the cursor in or beside it shows them again (see `decorations` below).
 */
export function linksIn(node: PMNode, start: number, decorations: Decoration[]) {
  let embeds = 0;
  node.descendants((child, pos) => {
    if (!child.isText || !child.text) return;
    const at = start + pos;
    for (const m of child.text.matchAll(WIKILINK_RE)) {
      const from = at + m.index;
      const to = from + m[0].length;
      const target = m[1].trim();
      const day = isDayTarget(splitTarget(target).note);
      const bang = m.index > 0 && child.text[m.index - 1] === "!";
      decorations.push(Decoration.inline(from, to, { class: day ? "wikilink daylink" : "wikilink", "data-target": target }, { wl: true, bang } satisfies LinkSpec));
      decorations.push(Decoration.inline(bang ? from - 1 : from, from + 2, { class: "wl-bracket" }, BRACKET), Decoration.inline(to - 2, to, { class: "wl-bracket" }, BRACKET));
      // ![[Note]] / ![[2026-11-03#Part]]: the note shown right under it.
      if (bang && isNoteEmbed(target)) decorations.push(embedWidget(target, to, embeds++));
    }
    for (const m of child.text.matchAll(TAG_RE)) {
      const from = at + m.index + m[1].length;
      decorations.push(Decoration.inline(from, from + m[2].length + 1, { class: "tag" }));
    }
  });
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
      new Plugin<DecorationSet>({
        key: new PluginKey("linkHighlight"),
        state: {
          init: (_, { doc }) => decorateAll(doc, linksIn),
          // Only the paragraphs an edit touched are searched again.
          apply: (tr, old) => redecorate(tr, old, linksIn),
        },
        props: {
          // Like Obsidian: a link shows without its [[ ]] unless the cursor is in it or right beside it.
          decorations(state) {
            const set = this.getState(state)!;
            const { from, to } = state.selection;
            const near = set.find(Math.max(0, from - 1), to + 1, (spec) => (spec as Partial<LinkSpec>).wl === true);
            const show: Decoration[] = [];
            for (const link of near) {
              const start = (link.spec as LinkSpec).bang ? link.from - 1 : link.from;
              if (to < start || from > link.to) continue;
              show.push(...set.find(start, link.to, (spec) => spec === BRACKET).filter((b) => b.from >= start && b.to <= link.to));
            }
            return show.length ? set.remove(show) : set;
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
