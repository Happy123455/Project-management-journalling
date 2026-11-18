import type { JSONContent } from "@tiptap/react";
import { docText } from "./words";

/**
 * 18 Nov: text typed right after a finished [[link]] searches inside the linked note.
 * "[[Recipes]]paneer" (or "[[Recipes]] paneer") lists the lines of Recipes with "paneer" in them;
 * picking one turns it into [[Recipes#…]], a link that opens Recipes with that spot lit up.
 */

/** The link a "]]" closes: the text just before it ends with "[[Target" (or "![[Target"). */
export function linkBefore(textBefore: string): string | null {
  const m = /\[\[([^[\]\n]{1,80})$/.exec(textBefore);
  if (!m) return null;
  const target = m[1].trim();
  // Already pointing into a part ([[Note#Part]]): nothing more to search for.
  if (!target || target.includes("#") || target.includes("|")) return null;
  return target;
}

/** What's typed after "]]" counts as a search: one optional space, then 2–40 plain characters. */
export function searchQuery(afterBrackets: string): string | null {
  const m = /^ ?([^\s[\]#|][^[\]#|\n]{1,39})$/.exec(afterBrackets);
  if (!m) return null;
  const q = m[1].trimEnd();
  return q.length >= 2 ? q : null;
}

const UNSAFE = /[[\]#|{}<>`"\\;=]/g;

/**
 * A short piece of the line around the match that finds that line again: up to three words before
 * the match, the words it touches and two after (whole words, at most eight in all).
 */
export function sectionFor(line: string, query: string): string {
  const clean = line.replace(UNSAFE, " ").replace(/\s+/g, " ").trim();
  const i = clean.toLowerCase().indexOf(query.toLowerCase());
  if (i < 0) return query.replace(UNSAFE, "").trim();
  // Whole words: back to the start of the word the match starts in, on to the end of the one it ends in.
  let a = i;
  while (a > 0 && clean[a - 1] !== " ") a--;
  let b = i + query.length;
  while (b < clean.length && clean[b] !== " ") b++;
  const before = clean.slice(0, a).trim().split(" ").filter(Boolean).slice(-3);
  const hit = clean.slice(a, b).split(" ").filter(Boolean);
  const after = clean.slice(b).trim().split(" ").filter(Boolean).slice(0, 2);
  return [...before, ...hit, ...after].slice(0, 8).join(" ").replace(/[.,:;!?]+$/, "");
}

export interface InsideHit {
  /** The line as it reads in the note (cut short when long). */
  line: string;
  /** What goes after the # in the link. */
  section: string;
}

/** Lines of a note with the query in them (any case), first ones first, each line once. */
export function insideMatches(doc: JSONContent | null | undefined, query: string, max = 5): InsideHit[] {
  if (!doc) return [];
  const q = query.toLowerCase();
  const out: InsideHit[] = [];
  const seen = new Set<string>();
  for (const raw of docText(doc).split("\n")) {
    const line = raw.trim();
    if (!line || !line.toLowerCase().includes(q)) continue;
    const section = sectionFor(line, query);
    if (!section || seen.has(section.toLowerCase())) continue;
    seen.add(section.toLowerCase());
    out.push({ line: line.length > 90 ? `${line.slice(0, 89)}…` : line, section });
    if (out.length >= max) break;
  }
  return out;
}
