import type { Special } from "../lib/specialDates";
import { dayKey } from "../lib/timestamp";

/**
 * Item 5 (12 Nov): the month's major events, and how the days after each one went.
 *
 * Events: a deadline's first day (⏳), its milestones (🚩) and its 🏁 due day, the bigger festivals
 * (the major ones) and birthdays/anniversaries, and days with far more writing than usual (✍️).
 * Each gets the change in writing over the week after it against the week before, which the month
 * shows when it opens: the event pulses and its effect spreads over the following days as a wave.
 */
export type EventKind = "due" | "start" | "milestone" | "festival" | "writing";

export interface MonthEvent {
  day: string;
  kind: EventKind;
  emoji: string;
  label: string;
  color?: string;
  /** Writing in the 7 days after against the 7 before: +0.4 = 40% more. Null when there's too little to say. */
  effect: number | null;
}

/** What monthEvents needs of a deadline. */
export interface EventDeadline {
  title: string;
  emoji: string;
  color: string;
  endAt: number;
  /** Its first day's bar. */
  start?: string;
  status?: string;
  steps: { text: string; at?: number }[];
}

const MAX_EVENTS = 10;
const RANK: Record<EventKind, number> = { due: 0, milestone: 1, start: 2, festival: 3, writing: 4 };
/** Wave reach in days after an event. */
export const REACH = 6;

const shift = (day: string, n: number) => {
  const [y, m, d] = day.split("-").map(Number);
  return dayKey(new Date(y, m - 1, d + n));
};

/** The change in writing over the week after `day` against the week before (only days up to today). */
export function effectOf(day: string, counts: Record<string, number>, today: string): number | null {
  let after = 0;
  let afterDays = 0;
  let before = 0;
  for (let i = 1; i <= 7; i++) {
    const a = shift(day, i);
    if (a <= today) {
      after += counts[a] ?? 0;
      afterDays++;
    }
    before += counts[shift(day, -i)] ?? 0;
  }
  if (afterDays < 3 || (after === 0 && before === 0)) return null;
  const avgAfter = after / afterDays;
  const avgBefore = before / 7;
  return Math.round(((avgAfter - avgBefore) / Math.max(avgBefore, 50)) * 100) / 100;
}

/** Days with far more writing than the month's usual: at least 300 words and twice the median, the top 3. */
export function writingPeaks(prefix: string, counts: Record<string, number>, today: string): string[] {
  const days = Object.entries(counts).filter(([d, n]) => d.startsWith(prefix) && d <= today && n > 0);
  if (days.length < 4) return [];
  const sorted = days.map(([, n]) => n).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  return days
    .filter(([, n]) => n >= 300 && n >= median * 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([d]) => d);
}

/** The month's ("YYYY-MM") major events, in day order. */
export function monthEvents(
  prefix: string,
  counts: Record<string, number>,
  today: string,
  deadlines: EventDeadline[],
  specialsOf: (day: string) => Special[],
): MonthEvent[] {
  const out: Omit<MonthEvent, "effect">[] = [];
  const inMonth = (d: string | undefined): d is string => !!d && d.startsWith(prefix);
  for (const t of deadlines) {
    if (t.status === "archived") continue;
    const due = t.endAt ? dayKey(new Date(t.endAt)) : undefined;
    if (inMonth(due)) out.push({ day: due, kind: "due", emoji: "🏁", label: `${t.title} due`, color: t.color });
    if (inMonth(t.start) && t.start !== due) out.push({ day: t.start, kind: "start", emoji: t.emoji || "⏳", label: `${t.title} starts`, color: t.color });
    for (const s of t.steps) {
      const d = s.at ? dayKey(new Date(s.at)) : undefined;
      if (inMonth(d)) out.push({ day: d, kind: "milestone", emoji: "🚩", label: s.text || "Milestone", color: t.color });
    }
  }
  const [y, m] = prefix.split("-").map(Number);
  const length = new Date(y, m, 0).getDate();
  const seen = new Set<string>();
  for (let d = 1; d <= length; d++) {
    const day = `${prefix}-${String(d).padStart(2, "0")}`;
    const s = specialsOf(day).find((x) => x.major || x.kind === "birthday" || x.kind === "anniversary");
    if (s && !seen.has(s.title)) {
      seen.add(s.title);
      out.push({ day, kind: "festival", emoji: s.emoji, label: s.title });
    }
  }
  for (const day of writingPeaks(prefix, counts, today)) out.push({ day, kind: "writing", emoji: "✍️", label: `${counts[day]} words` });
  return out
    .sort((a, b) => RANK[a.kind] - RANK[b.kind] || a.day.localeCompare(b.day))
    .slice(0, MAX_EVENTS)
    .sort((a, b) => a.day.localeCompare(b.day) || RANK[a.kind] - RANK[b.kind])
    .map((e) => ({ ...e, effect: e.day <= today ? effectOf(e.day, counts, today) : null }));
}

export interface Wave {
  /** ms after the month opens. */
  delay: number;
  /** 0–1: how strongly the wave reaches this day (fades with distance). */
  strength: number;
  color: string;
  /** The event's own day: it pulses. */
  source: boolean;
}

export const KIND_COLOR: Record<EventKind, string> = { due: "#ff5c5c", start: "#5b6cf0", milestone: "#e0913a", festival: "#ffc83d", writing: "#b26bff" };
const EVENT_GAP = 280;
const DAY_STEP = 110;

/** When and how strongly each day of the month is reached by an event's wave (the nearest, earliest one wins). */
export function waves(events: MonthEvent[], prefix: string): Map<string, Wave> {
  const out = new Map<string, Wave>();
  events.forEach((e, i) => {
    const t0 = i * EVENT_GAP;
    const color = e.color && e.kind !== "festival" && e.kind !== "writing" ? e.color : KIND_COLOR[e.kind];
    const put = (day: string, w: Wave) => {
      const had = out.get(day);
      if (!had || (w.source && !had.source) || (!had.source && w.delay < had.delay)) out.set(day, w);
    };
    put(e.day, { delay: t0, strength: 1, color, source: true });
    for (let n = 1; n <= REACH; n++) {
      const day = shift(e.day, n);
      if (!day.startsWith(prefix)) break;
      put(day, { delay: t0 + 180 + n * DAY_STEP, strength: Math.round((1 - n / (REACH + 1)) * 100) / 100, color, source: false });
    }
  });
  return out;
}

/** How long the whole animation runs (ms). */
export const waveLength = (events: MonthEvent[]) => (events.length ? (events.length - 1) * EVENT_GAP + 180 + REACH * DAY_STEP + 700 : 0);

/** "+40% writing after" / "−20% writing after". */
export function effectText(effect: number | null): string {
  if (effect === null) return "";
  const p = Math.round(effect * 100);
  if (Math.abs(p) < 5) return "writing about the same after";
  return `${p > 0 ? "+" : "−"}${Math.abs(p)}% writing after`;
}
