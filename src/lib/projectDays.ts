import { mentionsWithChildren } from "./links";

/** Month palette, light (1st) → dark (31st): Hapi's colours. */
export const MONTH_PALETTE: [string, string][] = [
  ["#A9C8EE", "#3F6FA8"], ["#9EA3EC", "#2A2FA6"], ["#C3A3EC", "#6A35A8"], ["#EBA8EE", "#9C3AA3"],
  ["#E6A9C2", "#9A3A62"], ["#E8A39E", "#9A3029"], ["#E9C29F", "#9A6332"], ["#EEEBA6", "#A39E3A"],
  ["#D6EDB0", "#6E9A35"], ["#A9E6A6", "#4A9A3A"], ["#A9E6CC", "#3E9A72"], ["#B0EEEE", "#4A9EA3"],
];

const hex = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));

/** A date's colour: its month's shade, lighter early in the month and darker towards the end. */
export function dayColor(date: string): string {
  const [, m, d] = date.split("-").map(Number);
  const [light, dark] = MONTH_PALETTE[m - 1].map(hex);
  const t = (d - 1) / 30;
  return `rgb(${light.map((v, i) => Math.round(v + (dark[i] - v) * t)).join(", ")})`;
}

const DAY_MS = 86_400_000;
const at = (d: string) => Date.parse(`${d}T12:00:00Z`);
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The dates strictly between two days (the days with no entry). */
export function gapDays(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = at(from) + DAY_MS; t < at(to); t += DAY_MS) out.push(iso(t));
  return out;
}

export interface ProjectEntry {
  day: string;
  /** The lines that mention the project, with what's nested under them. */
  lines: string[];
  /** "Day" set by hand in Block info on the mentioning line. */
  manual?: number;
}

/** Day N per entry (not per calendar day): a hand-set Day wins, otherwise one more than the entry before. */
export function numberEntries(entries: ProjectEntry[]): (ProjectEntry & { n: number })[] {
  let last = 0;
  return [...entries]
    .sort((a, b) => a.day.localeCompare(b.day))
    .map((e) => {
      last = e.manual ?? last + 1;
      return { ...e, n: last };
    });
}

interface Block {
  attrs?: Record<string, unknown>;
  content?: Block[];
  text?: string;
}

/** One day's entry for a project: its mentioning lines, and a hand-set Day if a mentioning block has one. */
export function entryFor(day: string, content: Block | null, title: string): ProjectEntry | null {
  const lines = mentionsWithChildren(content, "wikilink", title);
  if (!lines.length) return null;
  let manual: number | undefined;
  const find = (b: Block) => {
    const info = b.attrs?.info as Record<string, string> | undefined;
    const value = info && Object.entries(info).find(([k]) => k.trim().toLowerCase() === "day")?.[1];
    const text = JSON.stringify(b).toLowerCase();
    if (manual === undefined && value && /^\d+$/.test(value.trim()) && text.includes(`[[${title.toLowerCase()}`)) manual = Number(value);
    b.content?.forEach(find);
  };
  if (content) find(content);
  return { day, lines, manual };
}
