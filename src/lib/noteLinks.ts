import type { JSONContent } from "@tiptap/react";
import { addDays, dayKey, dayTitle } from "./timestamp";

/**
 * Links and embeds between notes, like Obsidian:
 * - [[2026-11-03]] links to a day, [[Ravi]] to a page;
 * - [[2026-11-03#Plans]] to a part of it: the heading "Plans" and what's under it (or the line
 *   that starts with "Plans" when there's no such heading);
 * - ![[2026-11-03]] / ![[Ravi#Plans]] show that note (or part) inline, read-only.
 * Backlinks count the note itself: a link to [[2026-11-03#Plans]] is a backlink of 2026-11-03.
 */

export const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
export const isDayTarget = (note: string) => DAY_RE.test(note.trim());

/** "2026-11-03#Plans" → note "2026-11-03", section "Plans" ("C#" stays a page named C#). */
export function splitTarget(target: string): { note: string; section: string | null } {
  const t = target.trim();
  const i = t.indexOf("#");
  if (i <= 0 || i === t.length - 1) return { note: t, section: null };
  return { note: t.slice(0, i).trim(), section: t.slice(i + 1).trim() || null };
}

/** Embeds of notes (not of photos and files, which are ![[attachments/…]] or ![[name.png]]). */
export function isNoteEmbed(target: string): boolean {
  const { note } = splitTarget(target);
  return !!note && !note.startsWith("attachments/") && !/\.[a-z0-9]{2,5}$/i.test(note);
}

/** How a link target reads: a day as its date, a section after a "›". */
export function targetLabel(target: string): string {
  const { note, section } = splitTarget(target);
  const name = isDayTarget(note) ? dayTitle(note) : note;
  return section ? `${name} › ${section}` : name;
}

const textOf = (b: JSONContent): string => (b.text ?? "") + (b.content ?? []).map(textOf).join("");
const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/** The headings of a note, in order (for suggestions after "#"). */
export function headingsIn(doc: JSONContent | null | undefined): string[] {
  const out: string[] = [];
  for (const b of doc?.content ?? []) if (b.type === "heading") {
    const t = textOf(b).trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/**
 * The blocks of a section: the heading named `section` and everything after it up to the next
 * heading of the same or a higher level. Without such a heading: the first block whose text starts
 * with it (or contains it), with the blocks indented under it. Null when nothing matches.
 */
export function sectionOf(doc: JSONContent | null | undefined, section: string): JSONContent[] | null {
  const blocks = doc?.content ?? [];
  const want = norm(section);
  if (!want) return null;
  const h = blocks.findIndex((b) => b.type === "heading" && norm(textOf(b)) === want);
  if (h >= 0) {
    const level = Number(blocks[h].attrs?.level ?? 1);
    let end = h + 1;
    while (end < blocks.length && !(blocks[end].type === "heading" && Number(blocks[end].attrs?.level ?? 1) <= level)) end++;
    return blocks.slice(h, end);
  }
  let i = blocks.findIndex((b) => norm(textOf(b)).startsWith(want));
  if (i < 0) i = blocks.findIndex((b) => norm(textOf(b)).includes(want));
  if (i < 0) return null;
  const indent = Number(blocks[i].attrs?.indent ?? 0);
  let end = i + 1;
  while (end < blocks.length && Number(blocks[end].attrs?.indent ?? 0) > indent) end++;
  return blocks.slice(i, end);
}

export interface DayOption {
  day: string;
  label: string;
}

/**
 * Days to suggest after "[[": today, yesterday and tomorrow, and the days that have something
 * written, matching what's typed ("2026-11", "nov 3", "monday", "yest").
 */
export function dayOptions(days: string[], query: string, today = dayKey(new Date()), max = 5): DayOption[] {
  const q = query.trim().toLowerCase();
  const named: DayOption[] = [
    { day: today, label: `Today · ${dayTitle(today)}` },
    { day: addDays(today, -1), label: `Yesterday · ${dayTitle(addDays(today, -1))}` },
    { day: addDays(today, 1), label: `Tomorrow · ${dayTitle(addDays(today, 1))}` },
  ];
  const all = [...named, ...days.filter((d) => !named.some((n) => n.day === d)).sort((a, b) => b.localeCompare(a)).map((d) => ({ day: d, label: dayTitle(d) }))];
  if (!q) return named;
  const words = q.split(/\s+/);
  return all.filter((o) => words.every((w) => o.day.includes(w) || o.label.toLowerCase().includes(w))).slice(0, max);
}
