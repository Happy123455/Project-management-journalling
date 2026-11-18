import { Extension } from "@tiptap/react";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { findRanges } from "../lib/search";

export interface FindState {
  terms: string[];
  /** Which match is the current one (highlighted more strongly, scrolled to). */
  index: number;
  matches: { from: number; to: number }[];
}

export const findKey = new PluginKey<FindState>("findHighlight");

/** Every match of the search words in the document, in order. */
export function findMatches(doc: PMNode, terms: string[]): { from: number; to: number }[] {
  if (!terms.length) return [];
  const out: { from: number; to: number }[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return;
    // One placeholder character per inline node keeps text offsets equal to document positions.
    const text = node.textBetween(0, node.content.size, undefined, "￼");
    for (const r of findRanges(text, terms)) out.push({ from: pos + 1 + r.start, to: pos + 1 + r.end });
    return false;
  });
  return out;
}

function decorate(doc: PMNode, state: FindState): DecorationSet {
  return DecorationSet.create(
    doc,
    state.matches.map((m, i) => Decoration.inline(m.from, m.to, { class: i === state.index ? "find-hit find-current" : "find-hit" })),
  );
}

/** Highlights the words from a search inside the open note; set with tr.setMeta(findKey, {terms, index}). */
export const FindHighlight = Extension.create({
  name: "findHighlight",
  addProseMirrorPlugins() {
    return [
      new Plugin<FindState>({
        key: findKey,
        state: {
          init: () => ({ terms: [], index: 0, matches: [] }),
          apply: (tr, prev) => {
            const meta = tr.getMeta(findKey) as { terms: string[]; index: number } | undefined;
            if (meta) return { terms: meta.terms, index: meta.index, matches: findMatches(tr.doc, meta.terms) };
            if (tr.docChanged && prev.terms.length) return { ...prev, matches: findMatches(tr.doc, prev.terms) };
            return prev;
          },
        },
        props: {
          decorations(state) {
            const s = findKey.getState(state);
            return s && s.matches.length ? decorate(state.doc, s) : null;
          },
        },
      }),
    ];
  },
});

/** A line of the note with matches: its text, where they are, and the number of its first match. */
export interface NoteLineMatch {
  text: string;
  ranges: { start: number; end: number }[];
  /** Index of its first match among all of the note's matches (the same order as findMatches). */
  first: number;
}

/** The note's text blocks that match, in order, numbered like findMatches (for "in this note"). */
export function matchLines(doc: PMNode, terms: string[], limit = 40): { lines: NoteLineMatch[]; total: number } {
  const lines: NoteLineMatch[] = [];
  let total = 0;
  if (!terms.length) return { lines, total };
  doc.descendants((node) => {
    if (!node.isTextblock) return;
    const text = node.textBetween(0, node.content.size, undefined, "￼");
    const ranges = findRanges(text, terms);
    if (ranges.length) {
      if (lines.length < limit) lines.push({ text: text.replace(/￼/g, " "), ranges, first: total });
      total += ranges.length;
    }
    return false;
  });
  return { lines, total };
}
