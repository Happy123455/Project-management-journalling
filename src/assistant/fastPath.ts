// Item 13: the assistant's fast path. Commands it can answer without any AI (and so offline, at no
// cost and at once): going to a day or a page, sums, unit changes and date questions. Anything
// it doesn't recognise goes on to the AI.
import { evaluate, formatAnswer } from "../lib/mathEval";
import { addDays, dayKey, MONTHS } from "../lib/timestamp";

export type Fast =
  /** Open a day (YYYY-MM-DD) or a page (the runner checks the page exists). */
  | { kind: "open"; day?: string; page?: string; newTab: boolean; end?: boolean; label: string }
  /** An answer to show (and read aloud when asked by voice). */
  | { kind: "answer"; text: string };

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MON = MONTHS.map((m) => m.toLowerCase());

const monthIndex = (w: string): number => {
  const x = w.toLowerCase().replace(/\.$/, "");
  if (x.length < 3) return -1;
  return MON.findIndex((m) => m.startsWith(x) || (x === "sept" && m === "september"));
};

const at = (day: string) => new Date(`${day}T12:00:00`);
const nice = (day: string) => {
  const d = at(day);
  return `${WEEKDAYS[d.getDay()][0].toUpperCase()}${WEEKDAYS[d.getDay()].slice(1)} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
};

/**
 * A day named in words: today, yesterday, tomorrow, "3 days ago", "in 2 weeks", "last monday",
 * "next fri", "monday", "3 nov", "nov 3", "3 november 2025", "2026-11-03", "3/11" (day/month).
 * A date with no year is the nearest one (this year, or last year when it's far in the future).
 */
export function parseDay(text: string, now: Date): string | null {
  const t = text.trim().toLowerCase().replace(/^(?:on|the)\s+/, "").replace(/[?.!,]+$/, "").replace(/(\d)(?:st|nd|rd|th)\b/g, "$1");
  const today = dayKey(now);
  if (t === "today" || t === "now") return today;
  if (t === "yesterday") return addDays(today, -1);
  if (t === "tomorrow") return addDays(today, 1);
  if (t === "day before yesterday") return addDays(today, -2);
  if (t === "day after tomorrow") return addDays(today, 2);
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return t;
  m = t.match(/^(\d+|a|an|one|two|three|four|five|six|seven)\s+(day|week|month|year)s?\s+(ago|back|before|later|from now|after)$/);
  const words: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7 };
  if (m) {
    const n = (words[m[1]] ?? Number(m[1])) * (m[3] === "ago" || m[3] === "back" || m[3] === "before" ? -1 : 1);
    return shift(today, n, m[2]);
  }
  m = t.match(/^in\s+(\d+|a|an|one|two|three|four|five|six|seven)\s+(day|week|month|year)s?$/);
  if (m) return shift(today, words[m[1]] ?? Number(m[1]), m[2]);
  m = t.match(/^(last|next|this)?\s*(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)[a-z]*$/);
  if (m) {
    const want = WEEKDAYS.findIndex((w) => w.startsWith(m![2].slice(0, 3)));
    const cur = now.getDay();
    let diff = want - cur;
    if (m[1] === "last") diff = diff >= 0 ? diff - 7 : diff;
    else if (m[1] === "next") diff = diff <= 0 ? diff + 7 : diff;
    else if (!m[1]) diff = diff > 0 ? diff - 7 : diff; // "monday": the last one (or today)
    return addDays(today, diff);
  }
  // 3 nov [2025] / nov 3 [2025] / 3/11[/2025]
  let d = 0;
  let mo = -1;
  let y = 0;
  if ((m = t.match(/^(\d{1,2})\s+([a-z.]+),?(?:\s+(\d{4}))?$/))) [d, mo, y] = [Number(m[1]), monthIndex(m[2]), Number(m[3] ?? 0)];
  else if ((m = t.match(/^([a-z.]+)\s+(\d{1,2}),?(?:\s+(\d{4}))?$/))) [d, mo, y] = [Number(m[2]), monthIndex(m[1]), Number(m[3] ?? 0)];
  else if ((m = t.match(/^(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2,4}))?$/))) [d, mo, y] = [Number(m[1]), Number(m[2]) - 1, m[3] ? Number(m[3].length === 2 ? `20${m[3]}` : m[3]) : 0];
  else return null;
  if (mo < 0 || mo > 11 || d < 1 || d > 31) return null;
  const make = (year: number) => `${year}-${String(mo + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  if (y) return valid(make(y));
  // No year: this year's, unless that's more than ~2 months ahead (then last year's).
  const mine = make(now.getFullYear());
  const out = (at(mine).getTime() - now.getTime()) / 86_400_000 > 62 ? make(now.getFullYear() - 1) : mine;
  return valid(out);
}

const valid = (day: string) => (dayKey(at(day)) === day ? day : null);

function shift(today: string, n: number, unit: string): string {
  if (unit === "day") return addDays(today, n);
  if (unit === "week") return addDays(today, n * 7);
  const d = at(today);
  if (unit === "month") d.setMonth(d.getMonth() + n);
  else d.setFullYear(d.getFullYear() + n);
  return dayKey(d);
}

/** "in a new tab" / "new tab" at the end or start: stripped, and noted. */
function tabWords(text: string): { rest: string; newTab: boolean } {
  const re = /\s*(?:,\s*)?(?:(?:in|on)\s+(?:a\s+)?new\s+tab|as\s+a\s+new\s+tab)\s*$/i;
  if (re.test(text)) return { rest: text.replace(re, ""), newTab: true };
  const lead = /^\s*(?:new\s+tab|open\s+in\s+(?:a\s+)?new\s+tab)\s*[:,-]?\s*/i;
  if (lead.test(text)) return { rest: text.replace(lead, ""), newTab: true };
  return { rest: text, newTab: false };
}

// ───── Units ─────

type Unit = { names: string[]; kind: string; toBase: (v: number) => number; fromBase: (v: number) => number; label: string };
const lin = (names: string[], kind: string, factor: number, label = names[0]): Unit => ({ names, kind, label, toBase: (v) => v * factor, fromBase: (v) => v / factor });
const UNITS: Unit[] = [
  lin(["km", "kms", "kilometer", "kilometers", "kilometre", "kilometres"], "len", 1000, "km"),
  lin(["m", "meter", "meters", "metre", "metres"], "len", 1, "m"),
  lin(["cm", "centimeter", "centimeters", "centimetre", "centimetres"], "len", 0.01, "cm"),
  lin(["mm", "millimeter", "millimeters"], "len", 0.001, "mm"),
  lin(["mi", "mile", "miles"], "len", 1609.344, "miles"),
  lin(["ft", "foot", "feet"], "len", 0.3048, "ft"),
  lin(["in", "inch", "inches"], "len", 0.0254, "in"),
  lin(["yd", "yard", "yards"], "len", 0.9144, "yd"),
  lin(["kg", "kgs", "kilo", "kilos", "kilogram", "kilograms"], "mass", 1, "kg"),
  lin(["g", "gram", "grams", "gm"], "mass", 0.001, "g"),
  lin(["lb", "lbs", "pound", "pounds"], "mass", 0.45359237, "lb"),
  lin(["oz", "ounce", "ounces"], "mass", 0.028349523125, "oz"),
  lin(["l", "liter", "liters", "litre", "litres"], "vol", 1, "L"),
  lin(["ml", "milliliter", "milliliters", "millilitre", "millilitres"], "vol", 0.001, "ml"),
  lin(["gal", "gallon", "gallons"], "vol", 3.785411784, "gallons"),
  lin(["cup", "cups"], "vol", 0.2365882365, "cups"),
  lin(["h", "hr", "hrs", "hour", "hours"], "time", 3600, "hours"),
  lin(["min", "mins", "minute", "minutes"], "time", 60, "minutes"),
  lin(["s", "sec", "secs", "second", "seconds"], "time", 1, "seconds"),
  lin(["day", "days"], "time", 86400, "days"),
  lin(["week", "weeks"], "time", 604800, "weeks"),
  lin(["kmh", "km/h", "kph"], "speed", 1 / 3.6, "km/h"),
  lin(["mph"], "speed", 0.44704, "mph"),
  { names: ["c", "°c", "celsius", "degc"], kind: "temp", label: "°C", toBase: (v) => v, fromBase: (v) => v },
  { names: ["f", "°f", "fahrenheit", "degf"], kind: "temp", label: "°F", toBase: (v) => ((v - 32) * 5) / 9, fromBase: (v) => (v * 9) / 5 + 32 },
  { names: ["k", "kelvin"], kind: "temp", label: "K", toBase: (v) => v - 273.15, fromBase: (v) => v + 273.15 },
];
const unitOf = (w: string) => UNITS.find((u) => u.names.includes(w.toLowerCase().replace(/^degrees?\s+/, "").replace(/\.$/, "")));

export function convert(text: string): string | null {
  const m = text
    .trim()
    .replace(/[?.!]+$/, "")
    .replace(/^(?:convert|what(?:'s| is)|how (?:many|much) is)\s+/i, "")
    .match(/^(-?[\d.,]+)\s*(°?\s?[a-z/°]+(?:\s+[a-z]+)?)\s+(?:in|to|into|as)\s+(°?[a-z/°]+)$/i);
  if (!m) return null;
  const v = Number(m[1].replace(/,/g, ""));
  const from = unitOf(m[2].replace(/\s+/g, " ").replace(/^degrees?\s+/i, ""));
  const to = unitOf(m[3]);
  if (!Number.isFinite(v) || !from || !to || from.kind !== to.kind || from === to) return null;
  const out = to.fromBase(from.toBase(v));
  const r = Math.abs(out) >= 100 ? Math.round(out * 10) / 10 : Math.round(out * 1000) / 1000;
  return `${formatAnswer(v)} ${from.label} = ${formatAnswer(r)} ${to.label}`;
}

// ───── Sums ─────

/** "23 by 67", "23 times 67", "15% of 240", "what is 2+2", "sqrt 81", "12 plus 5 minus 3". */
export function sum(text: string): string | null {
  let s = text
    .trim()
    .toLowerCase()
    .replace(/[?!]+$/, "")
    .replace(/^(?:what(?:'s| is)|calculate|calc|compute|how much is|solve)\s+/, "")
    .replace(/=\s*$/, "");
  const pct = s.match(/^([\d.,]+)\s*%\s*of\s*([\d.,]+)$/);
  if (pct) {
    const v = (Number(pct[1].replace(/,/g, "")) / 100) * Number(pct[2].replace(/,/g, ""));
    return `${pct[1]}% of ${pct[2]} = ${formatAnswer(v)}`;
  }
  // Only something that's clearly a sum: digits and operators (words for them are allowed).
  s = s
    .replace(/\b(?:multiplied by|times|into|by|x)\b/g, "*")
    .replace(/\bdivided by\b|\bover\b/g, "/")
    .replace(/\bplus\b|\band\b/g, "+")
    .replace(/\bminus\b|\bless\b/g, "-")
    .replace(/\bsquare root of\b|\bsquare root\b|\broot of\b/g, "sqrt ")
    .replace(/\bsquared\b/g, "^2")
    .replace(/\bcubed\b/g, "^3")
    .replace(/×/g, "*")
    .replace(/÷/g, "/")
    .replace(/,(?=\d{3}\b)/g, "");
  s = s.replace(/\bsqrt\s+([\d.]+)/g, "sqrt($1)");
  if (!/\d/.test(s) || /[a-z]{2,}/.test(s.replace(/\b(?:sqrt|sin|cos|tan|log|ln|abs|pi)\b/g, ""))) return null;
  if (!/[-+*/^%()]|sqrt|sin|cos|tan|log|ln|abs/.test(s)) return null;
  const v = evaluate(s);
  if (v === null || !Number.isFinite(v)) return null;
  return `${text.trim().replace(/[?=]+$/, "").trim()} = ${formatAnswer(v)}`;
}

// ───── Dates ─────

export function dateAnswer(text: string, now: Date): string | null {
  const t = text.trim().toLowerCase().replace(/[?.!]+$/, "");
  const today = dayKey(now);
  let m = t.match(/^(?:how many )?days? (?:until|till|to|left (?:until|till|to))\s+(.+)$/);
  if (m) {
    const day = futureDay(m[1], now);
    if (!day) return null;
    const n = Math.round((at(day).getTime() - at(today).getTime()) / 86_400_000);
    return `${n} day${n === 1 ? "" : "s"} until ${nice(day)}`;
  }
  m = t.match(/^(?:how many )?days? since\s+(.+)$/);
  if (m) {
    const day = parseDay(m[1], now);
    if (!day) return null;
    const n = Math.round((at(today).getTime() - at(day).getTime()) / 86_400_000);
    return `${n} day${n === 1 ? "" : "s"} since ${nice(day)}`;
  }
  m = t.match(/^(?:what day (?:is|was|will be)|which day is|what's the date|what is the date|date)\s*(.*)$/);
  if (m) {
    const what = (m[1] || "today").replace(/^(?:it\s*)?(?:on\s+)?/, "") || "today";
    const day = parseDay(what, now) ?? futureDay(what, now);
    return day ? nice(day) : null;
  }
  return null;
}

/** A date with no year, counted forward (for "days until 25 dec"). */
function futureDay(text: string, now: Date): string | null {
  const day = parseDay(text, now);
  if (!day) return null;
  if (/\d{4}/.test(text) || day >= dayKey(now)) return day;
  const d = at(day);
  d.setFullYear(d.getFullYear() + 1);
  const next = dayKey(d);
  return next.slice(5) === day.slice(5) ? next : day;
}

// ───── Opening notes ─────

function openCommand(text: string, now: Date): Fast | null {
  const { rest, newTab } = tabWords(text.trim().replace(/[.!]+$/, ""));
  let t = rest.trim();
  const verb = /^(?:open|go to|goto|show(?: me)?|take me to|jump to)\s+/i;
  const hasVerb = verb.test(t);
  t = t.replace(verb, "").replace(/^(?:the\s+)?(?:note|page|day)\s+(?:for|of|called)?\s*/i, "");
  // Today's end: "today's end", "end of today", "write today".
  if (/^(?:the\s+)?end of today|today'?s end|write (?:in )?today$/i.test(t)) return { kind: "open", day: dayKey(now), newTab, end: true, label: "the end of today" };
  const link = t.match(/^\[\[([^\]]+)\]\]$/);
  if (link) return { kind: "open", page: link[1].trim(), newTab, label: link[1].trim() };
  const day = parseDay(t.replace(/'s\s+(?:note|page)$/i, "").replace(/\s+(?:note|page)$/i, ""), now);
  if (day) return { kind: "open", day, newTab, label: nice(day) };
  // "open Work log": a page, if it exists (the runner checks). Short names only, no sentence.
  if (hasVerb && t && t.split(/\s+/).length <= 6 && !/\b(?:and|then|with|where|which|that|summar|find|search)\b/i.test(t)) return { kind: "open", page: t, newTab, label: t };
  return null;
}

/** The fast answer for a command, or null when it needs the AI. */
export function fastPath(text: string, now = new Date()): Fast | null {
  const t = text.trim();
  if (!t || t.includes("\n")) return null;
  const open = openCommand(t, now);
  if (open) return open;
  const d = dateAnswer(t, now);
  if (d) return { kind: "answer", text: d };
  const u = convert(t);
  if (u) return { kind: "answer", text: u };
  const s = sum(t);
  if (s) return { kind: "answer", text: s };
  return null;
}
