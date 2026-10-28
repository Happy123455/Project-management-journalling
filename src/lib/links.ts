export interface ExtractedLinks {
  wikilinks: string[];
  tags: string[];
}

// [[Page]] or [[Page|alias]]; the target is the part before "|".
export const WIKILINK_RE = /\[\[([^\[\]|\n]+)(?:\|[^\[\]\n]*)?\]\]/g;
// Obsidian-style tags: #tag or #tag/sub, not inside a word, not digits only.
export const TAG_RE = /(^|[^\w#&])#([\p{L}\p{N}_\-/]*[\p{L}_\-/][\p{L}\p{N}_\-/]*)/gu;

const unique = (items: string[]) => [...new Set(items)];

/** Names without repeats (ignoring letter case, first spelling wins), sorted. */
export function uniqueNames(names: string[]): string[] {
  const seen = new Map<string, string>();
  for (const n of names) if (!seen.has(n.toLowerCase())) seen.set(n.toLowerCase(), n);
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

/** Lines of `text` that link to `target` (kind "wikilink") or carry the tag `target`, ignoring letter case. */
export function linesMentioning(text: string, kind: "wikilink" | "tag", target: string): string[] {
  const want = target.toLowerCase();
  return text.split("\n").filter((line) => {
    const { wikilinks, tags } = extractLinks(line);
    return (kind === "wikilink" ? wikilinks : tags).some((t) => t.toLowerCase() === want);
  });
}

export function extractLinks(text: string): ExtractedLinks {
  const wikilinks = [...text.matchAll(WIKILINK_RE)].map((m) => m[1].trim()).filter(Boolean);
  const tags = [...text.matchAll(TAG_RE)].map((m) => m[2].replace(/\/+$/, "")).filter(Boolean);
  return { wikilinks: unique(wikilinks), tags: unique(tags) };
}
