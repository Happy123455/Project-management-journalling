export interface ExtractedLinks {
  wikilinks: string[];
  tags: string[];
}

// [[Page]] or [[Page|alias]]; the target is the part before "|".
export const WIKILINK_RE = /\[\[([^\[\]|\n]+)(?:\|[^\[\]\n]*)?\]\]/g;
// Obsidian-style tags: #tag or #tag/sub, not inside a word, not digits only.
export const TAG_RE = /(^|[^\w#&])#([\p{L}\p{N}_\-/]*[\p{L}_\-/][\p{L}\p{N}_\-/]*)/gu;

const unique = (items: string[]) => [...new Set(items)];

export function extractLinks(text: string): ExtractedLinks {
  const wikilinks = [...text.matchAll(WIKILINK_RE)].map((m) => m[1].trim()).filter(Boolean);
  const tags = [...text.matchAll(TAG_RE)].map((m) => m[2].replace(/\/+$/, "")).filter(Boolean);
  return { wikilinks: unique(wikilinks), tags: unique(tags) };
}
