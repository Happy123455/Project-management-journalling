/** Search words: split on spaces, lower-cased; "quoted phrases" stay together. */
export function searchTerms(query: string): string[] {
  const terms: string[] = [];
  for (const m of query.matchAll(/"([^"]+)"|(\S+)/g)) terms.push((m[1] ?? m[2]).toLowerCase());
  return terms.filter(Boolean);
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
