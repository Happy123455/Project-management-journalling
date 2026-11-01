import type { JSONContent } from "@tiptap/react";
import { linesMentioning } from "./links";

const textOf = (b: JSONContent): string => (b.text ?? "") + (b.content ?? []).map(textOf).join("");
const isList = (b: JSONContent) => /List$/.test(b.type ?? "");

/**
 * The parts of a note that mention `target`, with their structure kept (unlike mentionsWithChildren,
 * which gives lines of text): each mentioning block with the blocks nested under it, a mentioning
 * heading with the text under it, and list items (with their sub-items) inside a list of their own
 * kind. Used to show a project's or person's entries the way they look in the note.
 */
export function mentionBlocks(doc: JSONContent | null | undefined, kind: "wikilink" | "tag", target: string): JSONContent[] {
  const mentions = (b: JSONContent) => linesMentioning(textOf(b), kind, target).length > 0;
  const out: JSONContent[] = [];
  const pickItems = (list: JSONContent): JSONContent | null => {
    const kept: JSONContent[] = [];
    for (const item of list.content ?? []) {
      const own = (item.content ?? []).filter((c) => !isList(c));
      if (own.some(mentions)) {
        kept.push(item); // with everything nested under it
        continue;
      }
      // A mention deeper down: keep this item's own line as context for it.
      const subs = (item.content ?? []).filter(isList).map(pickItems).filter((x): x is JSONContent => !!x);
      if (subs.length) kept.push({ ...item, content: [...own, ...subs] });
    }
    return kept.length ? { ...list, content: kept } : null;
  };
  const blocks = doc?.content ?? [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (isList(b)) {
      if (mentions(b) && linesMentioning(textOf(b), kind, target).length) {
        const picked = pickItems(b);
        if (picked) out.push(picked);
      }
      continue;
    }
    if (!mentions(b)) continue;
    out.push(b);
    const level = Number(b.attrs?.indent ?? 0);
    const headingLevel = b.type === "heading" ? Number(b.attrs?.level ?? 1) : 0;
    let j = i + 1;
    for (; j < blocks.length; j++) {
      const n = blocks[j];
      const deeper = Number(n.attrs?.indent ?? 0) > level;
      // Under a heading: everything up to the next heading of its level, or a divider.
      const underHeading = headingLevel > 0 && !(n.type === "heading" && Number(n.attrs?.level ?? 1) <= headingLevel) && n.type !== "horizontalRule";
      if (!deeper && !underHeading) break;
      out.push(n);
    }
    i = j - 1;
  }
  return out;
}
