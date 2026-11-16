// Item 13: schedules for the assistant, written in words. "every day at 9 pm", "weekdays 7:30am",
// "mon and thu at 18:00", "every morning", "today at 6 pm", "tomorrow 8am", "on 20 nov at 9:00",
// "at 5pm" (once, the next 5 pm). A command may carry one at its start or end:
// "every day at 9 pm summarise today and read it".
import { addDays, dayKey } from "../lib/timestamp";
import { parseDay } from "./fastPath";

export interface Schedule {
  repeat: "daily" | "days" | "once";
  /** For "days": weekdays, 0 = Sunday. */
  days?: number[];
  /** For "once": YYYY-MM-DD. */
  day?: string;
  /** Minutes after midnight. */
  minute: number;
}

const WD = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const WD_RE = /^(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)[a-z]*?s?$/;
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

/** "9 pm", "21:00", "7:30am", "at 9" → minutes; the phrase without it. */
function takeTime(s: string): { minute: number; rest: string } | null {
  const re = /(?:^|\s)(at\s+)?(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?(?=\s|$|,)/g;
  for (const m of s.matchAll(re)) {
    const [, atWord, hs, ms, ap] = m;
    if (!atWord && !ms && !ap) continue;
    let h = Number(hs);
    const min = Number(ms ?? 0);
    if (h > 23 || min > 59) continue;
    if (ap) {
      if (h < 1 || h > 12) continue;
      h = (h % 12) + (ap.startsWith("p") ? 12 : 0);
    }
    return { minute: h * 60 + min, rest: (s.slice(0, m.index) + " " + s.slice((m.index ?? 0) + m[0].length)).replace(/\s+/g, " ").trim() };
  }
  return null;
}

const PART_TIME: Record<string, number> = { morning: 8 * 60, afternoon: 14 * 60, evening: 19 * 60, night: 21 * 60 };

/** A whole phrase as a schedule, or null when any of it isn't schedule words. */
export function parseSchedule(phrase: string, now = new Date()): Schedule | null {
  let s = phrase
    .toLowerCase()
    .replace(/^(?:schedule|scheduled|repeat|do (?:this|it))[:\s]+/, "")
    .replace(/[.!,;:]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return null;
  const t = takeTime(s);
  let minute = t?.minute ?? -1;
  s = (t ? t.rest : s).replace(/,/g, " ").replace(/\s+/g, " ").trim();
  // "every morning", "tonight": a part of the day stands in for a time.
  const part = s.match(/\b(?:every|each|in the|this)?\s*(morning|afternoon|evening|night)s?\b/);
  if (part) {
    if (minute < 0) minute = PART_TIME[part[1]];
    s = s.replace(part[0], /every|each/.test(part[0]) ? "every day" : "").trim();
  }
  if (s === "tonight") (s = "today"), minute < 0 && (minute = PART_TIME.night);
  if (minute < 0) return null;
  if (!s) {
    // A time alone: once, at the next one.
    const today = dayKey(now);
    const passed = now.getHours() * 60 + now.getMinutes() >= minute;
    return { repeat: "once", day: passed ? addDays(today, 1) : today, minute };
  }
  if (/^(?:every ?day|daily|each day|every day)$/.test(s)) return { repeat: "daily", minute };
  if (/^(?:every |on )?weekdays?$|^every weekday$|^mon(?:day)?\s*(?:-|to)\s*fri(?:day)?$/.test(s)) return { repeat: "days", days: [1, 2, 3, 4, 5], minute };
  if (/^(?:every |on )?weekends?$/.test(s)) return { repeat: "days", days: [0, 6], minute };
  if (s === "today") return { repeat: "once", day: dayKey(now), minute };
  if (s === "tomorrow") return { repeat: "once", day: addDays(dayKey(now), 1), minute };
  // Weekday names: "every mon and thu", "mondays", "on fri" (once, the next one).
  const words = s.replace(/^(every|each|on)\s+/, (_m, w) => (w === "on" ? "" : "every ")).split(/\s+|\s*&\s*/).filter((w) => w && w !== "and");
  const every = words[0] === "every";
  const names = every ? words.slice(1) : words;
  if (names.length && names.every((w) => WD_RE.test(w))) {
    const days = [...new Set(names.map((w) => WD.indexOf(w.slice(0, 3))))].sort();
    const plural = names.some((w) => /s$/.test(w) && !/^(tues|thurs)$/.test(w));
    if (every || plural || days.length > 1) return { repeat: "days", days, minute };
    const today = new Date(now);
    let diff = (days[0] - today.getDay() + 7) % 7;
    if (diff === 0 && now.getHours() * 60 + now.getMinutes() >= minute) diff = 7;
    return { repeat: "once", day: addDays(dayKey(now), diff), minute };
  }
  // "on 20 nov", "20 nov": once on that day (this year's or next year's if it has passed).
  const day = parseDay(s.replace(/^on\s+/, ""), now);
  if (day) {
    const d = day < dayKey(now) && !/\d{4}/.test(s) ? `${Number(day.slice(0, 4)) + 1}${day.slice(4)}` : day;
    return { repeat: "once", day: d, minute };
  }
  return null;
}

/**
 * A command with its schedule taken off the start or end: "every day at 9 pm: summarise today"
 * → the schedule and "summarise today". Null when there's none.
 */
export function splitSchedule(text: string, now = new Date()): { schedule: Schedule; rest: string } | null {
  const t = text.trim();
  if (t.includes("\n")) {
    // A block of steps: a schedule only on its own first or last line.
    const lines = t.split("\n");
    const first = parseSchedule(lines[0], now);
    if (first) return { schedule: first, rest: lines.slice(1).join("\n").trim() };
    const last = parseSchedule(lines[lines.length - 1], now);
    if (last) return { schedule: last, rest: lines.slice(0, -1).join("\n").trim() };
    return null;
  }
  const words = t.split(/\s+/);
  for (let n = Math.min(9, words.length - 1); n >= 1; n--) {
    const head = parseSchedule(words.slice(0, n).join(" "), now);
    if (head) return { schedule: head, rest: words.slice(n).join(" ").replace(/^[,:;-]\s*/, "").replace(/^(?:and\s+|then\s+)/i, "") };
    const tail = parseSchedule(words.slice(-n).join(" ").replace(/^(?:and|,)\s+/, ""), now);
    if (tail) return { schedule: tail, rest: words.slice(0, -n).join(" ").replace(/[,;]\s*$/, "").replace(/\s+(?:and|then)$/i, "") };
  }
  return null;
}

/** The next time it runs after `after`, or null (a one-off that's past). */
export function nextRun(s: Schedule, after: Date): Date | null {
  const at = (day: string) => {
    const d = new Date(`${day}T00:00:00`);
    d.setMinutes(s.minute);
    return d;
  };
  if (s.repeat === "once") {
    const d = s.day ? at(s.day) : null;
    return d && d > after ? d : null;
  }
  const today = dayKey(after);
  for (let i = 0; i < 8; i++) {
    const day = addDays(today, i);
    const d = at(day);
    if (d <= after) continue;
    if (s.repeat === "daily" || s.days?.includes(d.getDay())) return d;
  }
  return null;
}

/** The runs missed between `from` and `to` (the latest one only matters). */
export function missedRun(s: Schedule, from: Date, to: Date): Date | null {
  let last: Date | null = null;
  let cur = nextRun(s, from);
  for (let i = 0; cur && cur <= to && i < 400; i++) {
    last = cur;
    cur = nextRun(s, cur);
  }
  return last;
}

/** "every day at 21:00", "weekdays at 07:30", "Mon, Thu at 18:00", "once, Fri 20 Nov at 09:00". */
export function describeSchedule(s: Schedule): string {
  const time = `at ${hhmm(s.minute)}`;
  if (s.repeat === "daily") return `every day ${time}`;
  if (s.repeat === "days") {
    const d = s.days ?? [];
    if (d.join() === "1,2,3,4,5") return `weekdays ${time}`;
    if (d.join() === "0,6") return `weekends ${time}`;
    return `every ${d.map((x) => WD[x][0].toUpperCase() + WD[x].slice(1)).join(", ")} ${time}`;
  }
  const day = s.day ? new Date(`${s.day}T12:00:00`) : null;
  return day ? `once, ${day.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })} ${time}` : `once ${time}`;
}
