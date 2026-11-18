export interface ExtractedLinks {
  wikilinks: string[];
  tags: string[];
}

// [[Page]] or [[Page|alias]]; the target is the part before "|".
export const WIKILINK_RE = /\[\[([^\[\]|\n]+)(?:\|[^\[\]\n]*)?\]\]/g;
// Obsidian-style tags: #tag or #tag/sub, not inside a word, not digits only.
export const TAG_RE = /(^|[^\w#&])#([\p{L}\p{N}_\-/]*[\p{L}_\-/][\p{L}\p{N}_\-/]*)/gu;

const unique = (items: string[]) => [...new Set(items)];

/**
 * Is the text between [[ and ]] a note name? A long prompt, a JSON array ("[[1, 2], [3, 4]]") or
 * a sentence that happens to sit between double brackets isn't: those made junk notes in the graph
 * (Hapi, 17 Nov: the graph journaling prompt). A name is short, has a few words and no code marks.
 */
export const LINK_MAX = 80;
export function isLinkTarget(target: string): boolean {
  const t = target.trim();
  if (!t || t.length > LINK_MAX) return false;
  if (t.split(/\s+/).length > 12) return false;
  if (/[{}<>`"\\;=]|\s{3,}/.test(t)) return false;
  // Numbers and commas only: an array, not a name.
  if (/^[\d\s,.+-]+$/.test(t) && /,/.test(t)) return false;
  // A sentence: several full stops or question marks inside it.
  if ((t.match(/[.?!]\s/g)?.length ?? 0) >= 2) return false;
  return true;
}

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
    return (kind === "wikilink" ? wikilinks : tags).some((t) => t.toLowerCase() === want || (kind === "tag" && t.toLowerCase().startsWith(`${want}/`)));
  });
}

export function extractLinks(text: string): ExtractedLinks {
  // [[Note#Part]] links to Note (a backlink of the whole note); "C#" stays as it is.
  const wikilinks = [...text.matchAll(WIKILINK_RE)].filter((m) => isLinkTarget(m[1])).map((m) => m[1].trim().replace(/^([^#]+?)\s*#.+$/, "$1")).filter(Boolean);
  const tags = [...text.matchAll(TAG_RE)].map((m) => m[2].replace(/\/+$/, "")).filter(Boolean);
  return { wikilinks: unique(wikilinks), tags: unique(tags) };
}

interface Block {
  type?: string;
  attrs?: Record<string, unknown>;
  content?: Block[];
  text?: string;
}
const textOf = (b: Block): string => (b.text ?? "") + (b.content ?? []).map(textOf).join(b.type === "doc" ? "\n" : "");

/**
 * The lines of a note that mention `target`, each followed by what's nested under it (indented
 * blocks after it, or a list item's sub-items), so a project's, person's or log's page shows
 * everything written under its [[link]]. Nested lines come back indented with two spaces per level.
 */
export function mentionsWithChildren(doc: Block | null | undefined, kind: "wikilink" | "tag", target: string, taken?: Block[]): string[] {
  const out: string[] = [];
  const mentions = (t: string) => linesMentioning(t, kind, target).length > 0;
  const items = (list: Block, depth: number, include: boolean) => {
    for (const item of list.content ?? []) {
      const own = (item.content ?? []).filter((c) => !/List$/.test(c.type ?? "")).map(textOf).join(" ");
      const take = include || mentions(own);
      if (take && own.trim()) out.push("  ".repeat(depth) + own);
      if (take) taken?.push(...(item.content ?? []).filter((c) => !/List$/.test(c.type ?? "")));
      for (const sub of (item.content ?? []).filter((c) => /List$/.test(c.type ?? ""))) items(sub, depth + 1, take);
    }
  };
  const blocks = doc?.content ?? [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (/List$/.test(b.type ?? "")) {
      items(b, 0, false);
      continue;
    }
    const text = textOf(b);
    if (!mentions(text)) continue;
    out.push(text);
    taken?.push(b);
    const level = Number(b.attrs?.indent ?? 0);
    for (let j = i + 1; j < blocks.length && Number(blocks[j].attrs?.indent ?? 0) > level; j++) {
      taken?.push(blocks[j]);
      const t = textOf(blocks[j]);
      if (t.trim()) out.push("  ".repeat(Number(blocks[j].attrs?.indent ?? 0) - level) + t);
    }
  }
  return out;
}
