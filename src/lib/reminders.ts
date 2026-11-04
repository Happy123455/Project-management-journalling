import type { JSONContent } from "@tiptap/react";
import { addDays, TIMESTAMP_RE } from "./timestamp";

/** How often a reminder comes back. */
export type Repeat = "daily" | "weekly" | "monthly" | "yearly";
export const REPEATS: { value: Repeat; label: string }[] = [
  { value: "daily", label: "Every day" },
  { value: "weekly", label: "Every week" },
  { value: "monthly", label: "Every month" },
  { value: "yearly", label: "Every year" },
];

const at = (d: string) => new Date(`${d}T12:00:00`);
const key = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

/** The day `n` repeats after `day` (months and years keep the date, the 31st falls on the month's last day). */
export function stepDay(day: string, repeat: Repeat, n = 1): string {
  if (repeat === "daily") return addDays(day, n);
  if (repeat === "weekly") return addDays(day, 7 * n);
  const d = at(day);
  const [y, m, dd] = [d.getFullYear(), d.getMonth(), d.getDate()];
  const months = repeat === "monthly" ? n : 12 * n;
  const last = new Date(y, m + months + 1, 0).getDate();
  return key(new Date(y, m + months, Math.min(dd, last)));
}

/** The first time a repeating reminder from `day` falls on or after `from`. */
export function nextOccurrence(day: string, repeat: Repeat, from: string): string {
  if (day >= from) return day;
  // Jump close first (whole days per step), then walk.
  const perStep = { daily: 1, weekly: 7, monthly: 30.44, yearly: 365.25 }[repeat];
  const gap = (at(from).getTime() - at(day).getTime()) / 86_400_000;
  let n = Math.max(1, Math.floor(gap / perStep) - 1);
  let next = stepDay(day, repeat, n);
  while (next < from) next = stepDay(day, repeat, ++n);
  return next;
}

/** The days a repeating reminder falls on from `from` up to and including `to`. */
export function occurrences(day: string, repeat: Repeat, from: string, to: string, max = 60): string[] {
  const out: string[] = [];
  let next = nextOccurrence(day, repeat, from);
  for (let n = 0; next <= to && out.length < max; n++) {
    out.push(next);
    next = nextOccurrence(day, repeat, addDays(next, 1));
  }
  return out;
}

/** A time written in a line, with where it is: "15:00", "9:30", "3pm", "3:30 pm", "at 9". Hapi's timestamps (when a line was written) don't count. */
export function timeSpans(line: string): { hour: number; minute: number; index: number; length: number }[] {
  // Timestamps are blanked out (same length, so the places found still fit the line).
  const text = line.replace(new RegExp(`(✎ )?${TIMESTAMP_RE.source}`, "g"), (m) => " ".repeat(m.length));
  const out: { hour: number; minute: number; index: number; length: number }[] = [];
  for (const m of text.matchAll(/\b(1[0-2]|0?[1-9])(?:[:.]([0-5]\d))?\s?(am|pm|a\.m\.|p\.m\.)(?![a-z])/gi)) {
    let hour = Number(m[1]) % 12;
    if (m[3].toLowerCase().startsWith("p")) hour += 12;
    out.push({ hour, minute: Number(m[2] ?? 0), index: m.index!, length: m[0].length });
  }
  if (!out.length) {
    for (const m of text.matchAll(/(?<![\d:])([01]?\d|2[0-3]):([0-5]\d)(?![\d:])/g)) out.push({ hour: Number(m[1]), minute: Number(m[2]), index: m.index!, length: m[0].length });
  }
  if (!out.length) {
    const m = /\bat (1[0-2]|[1-9])\b(?![:.\d])/i.exec(text);
    if (m) {
      const h = Number(m[1]);
      // "at 9" means the morning, "at 3" the afternoon: the waking-hours reading.
      out.push({ hour: h < 7 ? h + 12 : h, minute: 0, index: m.index + 3, length: m[1].length });
    }
  }
  return out;
}

/** The times written in a line (see timeSpans). */
export function timesIn(line: string): { hour: number; minute: number }[] {
  return timeSpans(line).map(({ hour, minute }) => ({ hour, minute }));
}

const hhmm = (hour: number, minute: number) => `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;

/** A change to one line of a note: `del` characters at `index` replaced by `ins`. */
export interface LineEdit {
  index: number;
  del: number;
  ins: string;
}

/** Sets a line's reminder time: the first time in it changes, or "⏰ 15:00 " goes in front. */
export function timeEdit(line: string, hour: number, minute: number): LineEdit {
  const t = timeSpans(line)[0];
  if (t) return { index: t.index, del: t.length, ins: hhmm(hour, minute) };
  return { index: 0, del: 0, ins: `⏰ ${hhmm(hour, minute)} ` };
}

/** Lines ticked off with ✅ (or a checked task) don't ring again. */
export const DONE_MARK = "✅ ";
export const isDoneLine = (line: string) => line.trimStart().startsWith("✅");

/** The note's lines, as text (list items and nested lines each their own line). `open`: leave out lines that are done. */
export function noteLines(doc: JSONContent | null | undefined, open = false): string[] {
  const lines: string[] = [];
  const walk = (n: JSONContent) => {
    if (open && n.type === "taskItem" && n.attrs?.checked) return;
    if (n.type === "paragraph" || n.type === "heading") {
      lines.push((n.content ?? []).map((c) => c.text ?? "").join(""));
      return;
    }
    n.content?.forEach(walk);
  };
  walk(doc ?? { type: "doc" });
  return lines.filter((l) => l.trim() && !(open && isDoneLine(l)));
}

const clean = (s: string) =>
  s
    .replace(new RegExp(`(✎ )?${TIMESTAMP_RE.source}`, "g"), "")
    .replace(/\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g, (_, a, b) => b || a)
    .replace(/\s+/g, " ")
    .trim();

export interface Alarm {
  /** Stable for the same reminder line and time, so rescheduling replaces it. */
  id: string;
  /** When it goes off (ms since 1970, local time). */
  at: number;
  title: string;
  body: string;
  /** The day page to open when tapped. */
  day: string;
}

export interface ReminderSource {
  day: string;
  content: JSONContent;
  repeat?: Repeat;
  /** Days a repeating reminder was already ticked off on. */
  doneDays?: string[];
  /** A note that isn't a reminder (today's own): only its ⏰ lines count, and no morning nudge. */
  marked?: boolean;
}

/** In a day's own note, a line rings when it carries ⏰; in a reminder (written before its day), any timed line without a timestamp does. */
export function reminderLine(line: string, reminderPage: boolean): boolean {
  if (line.includes("⏰")) return true;
  return reminderPage && !new RegExp(TIMESTAMP_RE.source).test(line);
}

/**
 * The phone notifications for what's coming up: one at each time written in a reminder (on its
 * day, and on each repeat), and for a reminder without a time, one in the morning of its day.
 */
export function buildAlarms(reminders: ReminderSource[], now: Date, opts: { morningHour?: number; days?: number } = {}): Alarm[] {
  const morning = opts.morningHour ?? 8;
  const today = key(now);
  const until = addDays(today, opts.days ?? 45);
  const alarms: Alarm[] = [];
  for (const r of reminders) {
    const days = r.repeat ? occurrences(r.day, r.repeat, today, until) : r.day >= today && r.day <= until ? [r.day] : [];
    // Journal lines (with a timestamp) never ring; in a note that isn't a reminder, only ⏰ lines do.
    const all = noteLines(r.content, true);
    const lines = r.marked ? all.filter((l) => reminderLine(l, false)) : all;
    if (!lines.length) continue;
    for (const day of days) {
      if (r.doneDays?.includes(day)) continue;
      const [y, m, d] = day.split("-").map(Number);
      let timed = false;
      lines.forEach((line, i) => {
        if (!reminderLine(line, true) && !line.includes("⏰")) return;
        timesIn(line).forEach((t, j) => {
          timed = true;
          const when = new Date(y, m - 1, d, t.hour, t.minute).getTime();
          if (when <= now.getTime()) return;
          const hh = hhmm(t.hour, t.minute);
          alarms.push({ id: `${r.day}|${day}|${i}|${j}`, at: when, title: `🔔 ${hh}${r.repeat ? " 🔁" : ""}`, body: clean(line) || "Reminder", day: r.day });
        });
      });
      if (!timed && !r.marked) {
        const when = new Date(y, m - 1, d, morning, 0).getTime();
        if (when > now.getTime()) {
          const body = lines.slice(0, 3).map(clean).filter(Boolean).join(" · ");
          alarms.push({ id: `${r.day}|${day}|am`, at: when, title: `🔔 Today${r.repeat ? " 🔁" : ""}`, body: body || "Reminder", day: r.day });
        }
      }
    }
  }
  return alarms.sort((a, b) => a.at - b.at).slice(0, 200);
}

/** Something with a time today: a timed line in today's note, or a repeating reminder that falls today. */
export interface AgendaItem {
  /** Stable while the line stays the same. */
  id: string;
  at: number;
  text: string;
  /** The line as written (to change it). */
  line: string;
  /** The day page it's written on (today's, or a repeating reminder's own day). */
  day: string;
  repeat?: Repeat;
  done: boolean;
}

/**
 * Today's timed reminders, in time order: each time written in today's note (done ones included,
 * marked), and each repeating reminder that comes back today (ticked-off ones marked done).
 */
export function todayAgenda(todayPage: { content: JSONContent; reminder?: boolean } | null | undefined, repeating: ReminderSource[], today: string): AgendaItem[] {
  const [y, m, d] = today.split("-").map(Number);
  const out: AgendaItem[] = [];
  const add = (src: string, lines: string[], doneLines: Set<string>, repeat?: Repeat, doneToday = false) =>
    lines.forEach((line, i) =>
      timeSpans(line).forEach((t, j) =>
        out.push({ id: `${src}|${i}|${j}`, at: new Date(y, m - 1, d, t.hour, t.minute).getTime(), text: clean(line.replace(/^\s*✅\s*/, "")) || "Reminder", line, day: src, repeat, done: doneToday || !doneLines.has(line) }),
      ),
    );
  if (todayPage) {
    const lines = noteLines(todayPage.content).filter((l) => reminderLine(l, !!todayPage.reminder));
    add(today, lines, new Set(noteLines(todayPage.content, true)));
  }
  for (const r of repeating) {
    if (!r.repeat || r.day === today || nextOccurrence(r.day, r.repeat, today) !== today) continue;
    const lines = noteLines(r.content, true);
    add(r.day, lines, new Set(lines), r.repeat, !!r.doneDays?.includes(today));
  }
  return out.sort((a, b) => a.at - b.at);
}
