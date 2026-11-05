import { dayTitle } from "../lib/timestamp";

/** A note found by its title: a day ("Thursday, 5 November 2026") or a named page. */
export interface TitleHit {
  kind: "day" | "page";
  /** The day key (YYYY-MM-DD) or the page's title. */
  key: string;
  label: string;
}

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");

/**
 * Notes whose title has every word of the query (any letter case, in any order). Only titles are
 * looked at, never what the notes say. Titles starting with the query come first, then pages before
 * days, then the newest days.
 */
export function matchTitles(query: string, pages: string[], days: string[], today: string, limit = 40): TitleHit[] {
  const words = norm(query).split(/\s+/).filter(Boolean);
  const all: TitleHit[] = [
    ...[...new Set(pages.map((p) => p.trim()).filter(Boolean))].map((p) => ({ kind: "page" as const, key: p, label: p })),
    ...[...new Set([today, ...days])].sort((a, b) => b.localeCompare(a)).map((d) => ({ kind: "day" as const, key: d, label: dayTitle(d) })),
  ];
  if (!words.length) return [];
  const q = norm(query.trim());
  const hits = all.filter((h) => {
    const hay = norm(h.kind === "day" ? `${h.label} ${h.key}${h.key === today ? " today" : ""}` : h.label);
    return words.every((w) => hay.includes(w));
  });
  const starts = (h: TitleHit) => (norm(h.label).startsWith(q) || (h.kind === "day" && h.key.startsWith(q)) ? 0 : 1);
  return hits
    .map((h, i) => ({ h, i }))
    .sort((a, b) => starts(a.h) - starts(b.h) || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.h);
}
