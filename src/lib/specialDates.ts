// Festivals and personal dates (birthdays, anniversaries) for the month calendar's tiles.
// Festivals come from a small table (Hindu festival dates move with the moon, so they're listed
// per year from published calendars); personal dates from the "Special dates" page, one per line:
//   14 Mar · Mom's birthday 🎂        (every year)
//   1998-03-14 Mom's birthday         (every year, with the age)
//   2 Dec 2020 Our anniversary 💍
import type { JSONContent } from "@tiptap/core";

export type SpecialKind = "diwali" | "holi" | "uttarayan" | "newyear" | "birthday" | "anniversary" | "special";

export interface Special {
  kind: SpecialKind;
  title: string;
  emoji: string;
  greeting: string;
  /** For yearly personal dates with a known first year: how many years on this day. */
  years?: number;
}

export const SPECIAL_DATES_PAGE = "Special dates";

/** Diwali (Lakshmi Puja day) in India. Sources: diwali.info date table; dekhopanchang.com (2028–2030 agree). */
const DIWALI: Record<number, string> = {
  2025: "10-20",
  2026: "11-08",
  2027: "10-29",
  2028: "10-17",
  2029: "11-05",
  2030: "10-26",
  2031: "11-14",
  2032: "11-02",
};
/** Holi, the day of colours (Dhulandi). Source: templesinindiainfo.com Holi table; drikpanchang.com (2028 agrees). */
const HOLI: Record<number, string> = {
  2025: "03-14",
  2026: "03-04",
  2027: "03-22",
  2028: "03-11",
  2029: "03-01",
  2030: "03-20",
};

const FESTIVAL: Record<"diwali" | "holi" | "uttarayan" | "newyear", Omit<Special, "kind">> = {
  diwali: { title: "Diwali", emoji: "🪔", greeting: "Happy Diwali! May the lamps light up the year ahead." },
  holi: { title: "Holi", emoji: "🎨", greeting: "Happy Holi! A day of colours." },
  uttarayan: { title: "Uttarayan", emoji: "🪁", greeting: "Happy Uttarayan! Kai po che!" },
  newyear: { title: "New Year", emoji: "🎆", greeting: "Happy New Year!" },
};

/** The festivals on a "YYYY-MM-DD" day. */
export function festivalsOn(day: string): Special[] {
  const year = Number(day.slice(0, 4));
  const md = day.slice(5);
  const out: Special[] = [];
  if (md === "01-01") out.push({ kind: "newyear", ...FESTIVAL.newyear });
  if (md === "01-14") out.push({ kind: "uttarayan", ...FESTIVAL.uttarayan });
  if (HOLI[year] === md) out.push({ kind: "holi", ...FESTIVAL.holi });
  if (DIWALI[year] === md) out.push({ kind: "diwali", ...FESTIVAL.diwali });
  return out;
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
/** A month's index from its name or short name ("Mar", "March", "Sept"); -1 for other words. */
const monthOf = (w: string) => {
  const l = w.toLowerCase();
  return MONTHS.findIndex((m) => m === l || m.slice(0, 3) === l || (m === "september" && l === "sept"));
};

export interface PersonalDate {
  /** "MM-DD" */
  md: string;
  year?: number;
  kind: "birthday" | "anniversary" | "special";
  title: string;
}

/** A line's date and title, or null when the line doesn't start with a date. */
export function parseSpecialLine(line: string): PersonalDate | null {
  const s = line.replace(/^[\s\-*•·]+/, "").trim();
  if (!s) return null;
  let m: RegExpMatchArray | null;
  let month = -1;
  let day = 0;
  let year: number | undefined;
  let rest = "";
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})\b(.*)$/))) {
    year = Number(m[1]);
    month = Number(m[2]) - 1;
    day = Number(m[3]);
    rest = m[4];
  } else if ((m = s.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?(?:\s+(\d{4}))?\b(.*)$/)) && monthOf(m[2]) >= 0) {
    day = Number(m[1]);
    month = monthOf(m[2]);
    year = m[3] ? Number(m[3]) : undefined;
    rest = m[4];
  } else if ((m = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?(?:\s+(\d{4}))?\b(.*)$/)) && monthOf(m[1]) >= 0) {
    month = monthOf(m[1]);
    day = Number(m[2]);
    year = m[3] ? Number(m[3]) : undefined;
    rest = m[4];
  } else if ((m = s.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?\b(.*)$/))) {
    // Day first, as written in India.
    day = Number(m[1]);
    month = Number(m[2]) - 1;
    year = m[3] ? Number(m[3]) : undefined;
    rest = m[4];
  } else return null;
  if (month < 0 || month > 11 || day < 1 || day > new Date(2024, month + 1, 0).getDate()) return null;
  const title = rest.replace(/^[\s:·\-–—,]+/, "").trim();
  if (!title) return null;
  const kind = /birthday|b'?day|bday|janmdin|🎂|🎉/i.test(title) ? "birthday" : /anniversary|wedding|marriage|💍|💞/i.test(title) ? "anniversary" : "special";
  return { md: `${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`, year, kind, title };
}

/** The page's lines as plain text. */
export function pageLines(doc: JSONContent | null | undefined): string[] {
  const out: string[] = [];
  const walk = (n: JSONContent) => {
    if (n.type === "paragraph" || n.type === "heading" || n.type === "listItem" || n.type === "taskItem") {
      const text = (n.content ?? []).map(function t(c: JSONContent): string {
        return c.text ?? (c.type === "hardBreak" ? "\n" : (c.content ?? []).map(t).join(""));
      }).join("");
      if (n.type === "paragraph" || n.type === "heading") out.push(...text.split("\n"));
      else {
        for (const c of n.content ?? []) walk(c);
      }
      return;
    }
    for (const c of n.content ?? []) walk(c);
  };
  if (doc) walk(doc);
  return out;
}

export function parseSpecialPage(doc: JSONContent | null | undefined): PersonalDate[] {
  return pageLines(doc).map(parseSpecialLine).filter((d): d is PersonalDate => !!d);
}

const EMOJI = { birthday: "🎂", anniversary: "💞", special: "⭐" };

/** Everything special on a day: festivals first, then personal dates. */
export function specialsOn(day: string, personal: PersonalDate[]): Special[] {
  const out = festivalsOn(day);
  const md = day.slice(5);
  const year = Number(day.slice(0, 4));
  // 29 Feb dates are kept on 28 Feb in other years.
  const leap = new Date(year, 1, 29).getMonth() === 1;
  for (const p of personal) {
    if (p.md !== md && !(p.md === "02-29" && !leap && md === "02-28")) continue;
    if (p.year && p.year > year) continue;
    const years = p.year ? year - p.year : undefined;
    const greeting =
      p.kind === "birthday"
        ? years
          ? `Happy ${ordinal(years)} birthday!`
          : "Happy birthday!"
        : p.kind === "anniversary"
          ? years
            ? `${years} year${years === 1 ? "" : "s"} together. Happy anniversary!`
            : "Happy anniversary!"
          : p.title;
    out.push({ kind: p.kind, title: p.title, emoji: EMOJI[p.kind], greeting, years: years || undefined });
  }
  return out;
}

export function ordinal(n: number): string {
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th";
  return `${n}${s}`;
}

// ── Kept for the calendar (read from the page when the app opens, after syncs, and on return) ──

let personal: PersonalDate[] = [];
const listeners = new Set<() => void>();

export function setPersonalDates(list: PersonalDate[]) {
  const same = JSON.stringify(list) === JSON.stringify(personal);
  personal = list;
  if (!same) listeners.forEach((l) => l());
}
export const personalDates = () => personal;
export function subscribePersonalDates(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
