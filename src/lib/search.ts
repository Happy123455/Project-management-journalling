import type { JSONContent } from "@tiptap/react";

/** Words that must be found together: on one line, in one block (paragraph) or one section (under one heading). */
export interface QueryGroup {
  scope: "line" | "block" | "section" | "file";
  terms: string[];
}

const plainTerms = (q: string) => {
  const terms: string[] = [];
  for (const m of q.matchAll(/"([^"]+)"|(\S+)/g)) terms.push((m[1] ?? m[2]).toLowerCase());
  return terms.filter(Boolean);
};

/**
 * A search, like Obsidian's: words (anywhere in the note), "quoted phrases", and
 * line:(alphabet microsoft) / block:(…) / section:(…) for words that must be on the same line,
 * in the same paragraph or under the same heading. line:alphabet (one word) works too.
 */
export function parseQuery(query: string): { terms: string[]; groups: QueryGroup[] } {
  const groups: QueryGroup[] = [];
  const rest = query.replace(/\b(line|block|section|file):(?:\(([^)]*)\)?|"([^"]*)"|(\S+))/gi, (_m, scope: string, paren?: string, quoted?: string, word?: string) => {
    const terms = quoted != null ? [quoted.toLowerCase()].filter(Boolean) : plainTerms(paren ?? word ?? "");
    if (terms.length) groups.push({ scope: scope.toLowerCase() as QueryGroup["scope"], terms });
    return " ";
  });
  return { terms: plainTerms(rest), groups };
}

/** Every word of a search (its groups' words too), lower-cased; "quoted phrases" stay together. */
export function searchTerms(query: string): string[] {
  const { terms, groups } = parseQuery(query);
  return [...new Set([...terms, ...groups.flatMap((g) => g.terms)])];
}

export interface DocLine {
  text: string;
  /** Which heading's part it's in (0 before the first heading). */
  section: number;
  /** Which paragraph (text block) it belongs to. */
  block: number;
}

/** A note's lines, each with its section and block, for line:/block:/section: searches. */
export function docLines(doc: JSONContent | null | undefined, title?: string): DocLine[] {
  const out: DocLine[] = [];
  let section = 0;
  let block = 0;
  if (title) out.push({ text: title, section: 0, block: block++ });
  const inline = (n: JSONContent): string => (n.type === "hardBreak" ? "\n" : (n.text ?? "") + (n.content ?? []).map(inline).join(""));
  const walk = (n: JSONContent, top: boolean) => {
    if (top && n.type === "heading") section++;
    const isText = n.type === "paragraph" || n.type === "heading" || n.type === "codeBlock";
    if (isText) {
      const b = block++;
      for (const line of inline(n).split("\n")) out.push({ text: line, section, block: b });
      return;
    }
    for (const c of n.content ?? []) walk(c, false);
  };
  for (const b of doc?.content ?? []) walk(b, true);
  return out;
}

/** True when every group's words are found together (on one line, in one block or one section). */
export function fitsGroups(lines: DocLine[], groups: QueryGroup[], names = ""): boolean {
  return groups.every((g) => {
    if (g.scope === "file") return g.terms.every((t) => names.includes(t));
    if (g.scope === "line") return lines.some((l) => g.terms.every((t) => l.text.toLowerCase().includes(t)));
    const parts = new Map<number, string>();
    for (const l of lines) {
      const k = g.scope === "block" ? l.block : l.section;
      parts.set(k, `${parts.get(k) ?? ""}\n${l.text.toLowerCase()}`);
    }
    return [...parts.values()].some((text) => g.terms.every((t) => text.includes(t)));
  });
}

/** Does a note (its document, and a page's title) fit the search? */
export function docMatches(doc: JSONContent | null | undefined, query: string, title?: string): boolean {
  const { groups } = parseQuery(query);
  return !groups.length || fitsGroups(docLines(doc, title), groups, groups.some((g) => g.scope === "file") ? docNames(doc, title) : "");
}

/** Does the search have a file:(…) part (titles of notes, projects, links and files only)? */
export const hasFileScope = (query: string) => parseQuery(query).groups.some((g) => g.scope === "file");

/**
 * For file:(…): the note's or project's title and the titles of what's linked in it (link cards,
 * [[page]] links, attached files), lower-cased, one per line.
 */
export function docNames(doc: JSONContent | null | undefined, title?: string): string {
  const out: string[] = title ? [title] : [];
  const walk = (n: JSONContent) => {
    const t = n.type ?? "";
    if (/link|card|attach|mention|embed|page/i.test(t) && n.attrs)
      for (const k of ["title", "name", "url", "page", "label", "site", "siteName", "fileName"]) if (typeof n.attrs[k] === "string" && n.attrs[k]) out.push(n.attrs[k]);
    for (const m of n.marks ?? []) if (/link/i.test(m.type) && m.attrs) for (const k of ["href", "title", "page"]) if (typeof m.attrs[k] === "string" && m.attrs[k]) out.push(m.attrs[k]);
    const wiki = n.text?.match(/\[\[([^\]]+)\]\]/g);
    if (wiki) out.push(...wiki.map((w) => w.slice(2, -2)));
    for (const c of n.content ?? []) walk(c);
  };
  for (const b of doc?.content ?? []) walk(b);
  return out.join("\n").toLowerCase();
}

export interface Range {
  start: number;
  end: number;
}

export interface LineMatch {
  text: string;
  ranges: Range[];
}

/** Where each term occurs in a line, merged and in order. */
export function findRanges(line: string, terms: string[]): Range[] {
  const lower = line.toLowerCase();
  const ranges: Range[] = [];
  for (const term of terms) {
    for (let i = lower.indexOf(term); i !== -1; i = lower.indexOf(term, i + term.length)) ranges.push({ start: i, end: i + term.length });
  }
  ranges.sort((a, b) => a.start - b.start);
  const merged: Range[] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  return merged;
}

/**
 * A page matches when every term appears somewhere in it. Returns how many times the terms
 * occur (for the calendar's yellow density) and the lines to show, or null when it doesn't match.
 */
export function matchText(text: string, terms: string[]): { count: number; lines: LineMatch[] } | null {
  if (!terms.length) return null;
  const lower = text.toLowerCase();
  if (!terms.every((t) => lower.includes(t))) return null;
  const lines: LineMatch[] = [];
  let count = 0;
  for (const line of text.split("\n")) {
    const ranges = findRanges(line, terms);
    if (!ranges.length) continue;
    count += terms.reduce((n, t) => n + line.toLowerCase().split(t).length - 1, 0);
    lines.push({ text: line, ranges });
  }
  return { count, lines };
}

/** Splits a line into plain and highlighted parts for display. */
export function highlightParts(line: LineMatch): { text: string; hit: boolean }[] {
  const parts: { text: string; hit: boolean }[] = [];
  let at = 0;
  for (const r of line.ranges) {
    if (r.start > at) parts.push({ text: line.text.slice(at, r.start), hit: false });
    parts.push({ text: line.text.slice(r.start, r.end), hit: true });
    at = r.end;
  }
  if (at < line.text.length) parts.push({ text: line.text.slice(at), hit: false });
  return parts;
}
