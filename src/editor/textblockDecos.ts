import type { Node as PMNode } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

/**
 * Decorations that only depend on the text of each paragraph (links, tags, timestamps, formulas).
 *
 * Smoothness (2026-11-10): these used to be worked out again for the WHOLE note on every letter
 * typed, and ProseMirror then rebuilt its decoration tree from scratch. In a 600-line note that
 * was most of the ~18 ms each key cost on a laptop (several times that on the phone). Now only
 * the paragraphs an edit touched are searched again; everything else just moves along.
 */

/** `decorate(node, start, out)` adds the decorations for `node`'s content, `start` = where its content begins. */
export type DecorateIn = (node: PMNode, start: number, out: Decoration[]) => void;

/** Past this many touched paragraphs (a paste, a note replaced), a full pass is quicker. */
const MANY = 50;

/** The text blocks an edit touched, by position in the new doc. */
export function touchedTextblocks(tr: Transaction): Map<number, PMNode> | null {
  const blocks = new Map<number, PMNode>();
  const size = tr.doc.content.size;
  let tooMany = false;
  tr.mapping.maps.forEach((map, i) => {
    if (tooMany) return;
    const rest = tr.mapping.slice(i + 1);
    map.forEach((_a, _b, newStart, newEnd) => {
      if (tooMany) return;
      const from = Math.max(0, Math.min(rest.map(newStart, -1), size));
      const to = Math.max(from, Math.min(rest.map(newEnd, 1), size));
      tr.doc.nodesBetween(from, to, (node, pos) => {
        if (tooMany) return false;
        if (!node.isTextblock) return true;
        blocks.set(pos, node);
        if (blocks.size > MANY) tooMany = true;
        return false;
      });
    });
  });
  return tooMany ? null : blocks;
}

/** The whole doc's decorations. */
export function decorateAll(doc: PMNode, decorate: DecorateIn): DecorationSet {
  const out: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    decorate(node, pos + 1, out);
    return false;
  });
  return DecorationSet.create(doc, out);
}

/** After an edit: the old decorations moved along, the touched paragraphs done again. */
export function redecorate(tr: Transaction, old: DecorationSet, decorate: DecorateIn): DecorationSet {
  if (!tr.docChanged) return old;
  const blocks = touchedTextblocks(tr);
  if (!blocks) return decorateAll(tr.doc, decorate);
  let set = old.map(tr.mapping, tr.doc);
  const fresh: Decoration[] = [];
  for (const [pos, node] of blocks) {
    const stale = set.find(pos, pos + node.nodeSize);
    if (stale.length) set = set.remove(stale);
    decorate(node, pos + 1, fresh);
  }
  return fresh.length ? set.add(tr.doc, fresh) : set;
}
