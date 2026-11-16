// Festivals and personal dates (birthdays, anniversaries) for the month calendar's tiles.
// Festivals come from a small table (Hindu festival dates move with the moon, so they're listed
// per year from published calendars); personal dates from the "Special dates" page, one per line:
//   14 Mar · Mom's birthday 🎂        (every year)
//   1998-03-14 Mom's birthday         (every year, with the age)
//   2 Dec 2020 Our anniversary 💍
import type { JSONContent } from "@tiptap/core";

/** A tile's look (its CSS class is fest-<look>): festivals share a few cheap looks, personal dates have their own. */
export type Look =
  | "diwali" | "holi" | "uttarayan" | "newyear" | "christmas" | "lamp" | "flag" | "moon" | "temple" | "garba" | "rakhi"
  | "harvest" | "bloom" | "heart" | "spooky" | "lantern" | "earth" | "sun";
export type SpecialKind = Look | "birthday" | "anniversary" | "special";
/** Settings → Editor: festival groups that can be switched off. */
export type FestGroup = "india" | "world" | "fun";
export const FEST_GROUPS: { id: FestGroup; label: string; hint: string }[] = [
  { id: "india", label: "🇮🇳 India", hint: "Diwali, Navratri, Uttarayan, Eid, Republic Day…" },
  { id: "world", label: "🌍 World", hint: "Christmas, New Year's Eve, Easter, Lunar New Year, Thanksgiving" },
  { id: "fun", label: "🎈 Fun days", hint: "Valentine's, Halloween, Mother's and Father's Day, Earth Day, Women's Day, Teachers' Day" },
];

export interface Special {
  kind: SpecialKind;
  title: string;
  /** A few letters for the tile ("Xmas"). */
  short?: string;
  emoji: string;
  greeting: string;
  /** For yearly personal dates with a known first year: how many years on this day. */
  years?: number;
  /** Festivals: their group. */
  group?: FestGroup;
  /** Usually a school or college holiday in Gujarat (🏫). */
  school?: boolean;
  /** Moon-sighted (Islamic) or regional day: it can move by a day. */
  approx?: boolean;
  /** One of the big ones (marked as a major event in the month). */
  major?: boolean;
}

export const SPECIAL_DATES_PAGE = "Special dates";

type YearTable = Record<number, string>;

/** Diwali (Lakshmi Puja day) in India. Sources: diwali.info date table; dekhopanchang.com (2028–2030 agree). */
const DIWALI: YearTable = {
  2025: "10-20",
  2026: "11-08",
  2027: "10-29",
  2028: "10-17",
  2029: "11-05",
  2030: "10-26",
  2031: "11-14",
  2032: "11-02",
};
/** Holi, the day of colours (Dhulandi). Source: templesinindiainfo.com Holi table; drikpanchang.com (2028 agrees); 2027: samvat.in and tirth.com. */
const HOLI: YearTable = {
  2025: "03-14",
  2026: "03-04",
  2027: "03-22",
  2028: "03-11",
  2029: "03-01",
  2030: "03-20",
};

/**
 * Days that move with the moon, 2026–2028, as published for India (New Delhi). Sources, read 16 Nov
 * 2026: thedeepdharma.com/festivals/2026 and /2027, samvat.in/festivals/2026–2028 and tirth.com
 * 2027–2028 (they agree where both list a day); Wikipedia for Lunar New Year and the Islamic days.
 * Marked ≈ (approx) where the day is worked out from its tithi (Mahavir Jayanti: two days before
 * Chaitra Purnima; Kali Chaudas: the night before Diwali; Labh Pancham: Bestu Varas + 4) or depends
 * on the moon being seen (Eid, Muharram, Milad-un-Nabi: the usual Indian day, a day after Saudi
 * Arabia) or on a calendar without leap years (Parsi New Year).
 */
const T: Record<string, YearTable> = {
  lohri: { 2026: "01-13", 2027: "01-14", 2028: "01-14" },
  pongal: { 2026: "01-14", 2027: "01-15", 2028: "01-15" },
  lunarny: { 2026: "02-17", 2027: "02-06", 2028: "01-26" },
  shivratri: { 2026: "02-15", 2027: "03-06", 2028: "02-23" },
  ugadi: { 2026: "03-19", 2027: "04-07", 2028: "03-27" },
  ramnavami: { 2026: "03-26", 2027: "04-15", 2028: "04-03" },
  mahavir: { 2026: "03-31", 2027: "04-18", 2028: "04-07" },
  hanuman: { 2026: "04-02", 2027: "04-20", 2028: "04-09" },
  baisakhi: { 2026: "04-14", 2027: "04-14", 2028: "04-13" },
  akshaya: { 2026: "04-20", 2027: "05-09", 2028: "04-27" },
  buddha: { 2026: "05-01", 2027: "05-20", 2028: "05-08" },
  rathyatra: { 2026: "07-16", 2027: "07-05", 2028: "06-24" },
  rakhi: { 2026: "08-28", 2027: "08-17", 2028: "08-05" },
  onam: { 2026: "08-26", 2027: "09-12", 2028: "09-01" },
  janmashtami: { 2026: "09-04", 2027: "08-24", 2028: "08-13" },
  ganesh: { 2026: "09-14", 2027: "09-04", 2028: "08-23" },
  navratri: { 2026: "10-11", 2027: "09-30", 2028: "09-19" },
  dussehra: { 2026: "10-20", 2027: "10-09", 2028: "09-27" },
  sharad: { 2026: "10-25", 2027: "10-15", 2028: "10-02" },
  karwa: { 2026: "10-29", 2027: "10-18", 2028: "10-07" },
  dhanteras: { 2026: "11-06", 2027: "10-27", 2028: "10-15" },
  kalichaudas: { 2026: "11-07", 2027: "10-28", 2028: "10-16" },
  bestu: { 2026: "11-10", 2027: "10-30", 2028: "10-18" },
  bhaidooj: { 2026: "11-11", 2027: "10-31", 2028: "10-19" },
  labh: { 2026: "11-14", 2027: "11-03", 2028: "10-22" },
  chhath: { 2026: "11-15", 2027: "11-04", 2028: "10-23" },
  devdiwali: { 2026: "11-24", 2027: "11-14", 2028: "11-02" },
  eidfitr: { 2026: "03-21", 2027: "03-10", 2028: "02-27" },
  eidadha: { 2026: "05-27", 2027: "05-17", 2028: "05-05" },
  muharram: { 2026: "06-26", 2027: "06-15", 2028: "06-04" },
  milad: { 2026: "08-26", 2027: "08-15", 2028: "08-04" },
  parsi: { 2026: "08-15", 2027: "08-15", 2028: "08-14" },
};

const md = (d: Date) => `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
/** Western Easter Sunday (anonymous Gregorian computus). */
export function easter(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
const shift = (year: number, mmdd: string, days: number) => md(new Date(year, Number(mmdd.slice(0, 2)) - 1, Number(mmdd.slice(3)) + days));
/** The n-th `weekday` (0 = Sunday) of a month (1–12). */
const nth = (year: number, month: number, weekday: number, n: number) => {
  const first = new Date(year, month - 1, 1).getDay();
  return md(new Date(year, month - 1, 1 + ((weekday - first + 7) % 7) + (n - 1) * 7));
};

interface FestDef {
  title: string;
  short: string;
  emoji: string;
  greeting: string;
  look: Look;
  group: FestGroup;
  school?: boolean;
  approx?: boolean;
  major?: boolean;
  /** Its days ("MM-DD") in a year: a fixed day, a table, or worked out. */
  on: string | YearTable | ((year: number) => string[]);
}

/** Every festival, the most important first (the first one on a day gives the tile its look). */
const FESTS: FestDef[] = [
  { title: "Diwali", major: true, short: "Diwali", emoji: "🪔", greeting: "Happy Diwali! May the lamps light up the year ahead.", look: "diwali", group: "india", school: true, on: DIWALI },
  { title: "Christmas", major: true, short: "Xmas", emoji: "🎄", greeting: "Merry Christmas! 🎅", look: "christmas", group: "world", school: true, on: "12-25" },
  { title: "Holi", major: true, short: "Holi", emoji: "🎨", greeting: "Happy Holi! A day of colours.", look: "holi", group: "india", school: true, on: HOLI },
  { title: "Uttarayan", major: true, short: "Kites", emoji: "🪁", greeting: "Happy Uttarayan! Kai po che!", look: "uttarayan", group: "india", school: true, on: "01-14" },
  { title: "Bestu Varas", major: true, short: "New Yr", emoji: "🌅", greeting: "Saal Mubarak! A happy Gujarati New Year.", look: "lamp", group: "india", school: true, on: T.bestu },
  { title: "New Year", major: true, short: "New Yr", emoji: "🎆", greeting: "Happy New Year!", look: "newyear", group: "world", on: "01-01" },
  { title: "Republic Day", major: true, short: "Rep Day", emoji: "🇮🇳", greeting: "Happy Republic Day! Jai Hind.", look: "flag", group: "india", school: true, on: "01-26" },
  { title: "Independence Day", major: true, short: "Indep.", emoji: "🇮🇳", greeting: "Happy Independence Day! Jai Hind.", look: "flag", group: "india", school: true, on: "08-15" },
  { title: "Gandhi Jayanti", short: "Gandhi", emoji: "🕊️", greeting: "Gandhi Jayanti: truth and non-violence.", look: "flag", group: "india", school: true, on: "10-02" },
  { title: "Navratri", major: true, short: "Garba", emoji: "💃", greeting: "Happy Navratri! Nine nights of garba.", look: "garba", group: "india", on: (y) => span(T.navratri[y], T.dussehra[y], y) },
  { title: "Dussehra", major: true, short: "Dussehra", emoji: "🏹", greeting: "Happy Dussehra! Good wins over evil.", look: "sun", group: "india", school: true, on: T.dussehra },
  { title: "Janmashtami", major: true, short: "Krishna", emoji: "🦚", greeting: "Happy Janmashtami! Jai Shri Krishna.", look: "temple", group: "india", school: true, on: T.janmashtami },
  { title: "Raksha Bandhan", major: true, short: "Rakhi", emoji: "🧶", greeting: "Happy Raksha Bandhan!", look: "rakhi", group: "india", school: true, on: T.rakhi },
  { title: "Ganesh Chaturthi", major: true, short: "Ganesh", emoji: "🐘", greeting: "Ganpati Bappa Morya!", look: "temple", group: "india", on: T.ganesh },
  { title: "Maha Shivratri", short: "Shivratri", emoji: "🔱", greeting: "Har Har Mahadev! Happy Maha Shivratri.", look: "temple", group: "india", school: true, on: T.shivratri },
  { title: "Ram Navami", short: "Ram Nav.", emoji: "🏹", greeting: "Happy Ram Navami! Jai Shri Ram.", look: "temple", group: "india", school: true, on: T.ramnavami },
  { title: "Hanuman Jayanti", short: "Hanuman", emoji: "🙏", greeting: "Happy Hanuman Jayanti!", look: "temple", group: "india", on: T.hanuman },
  { title: "Mahavir Jayanti", short: "Mahavir", emoji: "🙏", greeting: "Happy Mahavir Jayanti!", look: "temple", group: "india", school: true, approx: true, on: T.mahavir },
  { title: "Buddha Purnima", short: "Buddha", emoji: "☸️", greeting: "Happy Buddha Purnima!", look: "moon", group: "india", on: T.buddha },
  { title: "Akshaya Tritiya", short: "Akha Trij", emoji: "🪙", greeting: "Happy Akshaya Tritiya! A good day to begin.", look: "lamp", group: "india", on: T.akshaya },
  { title: "Rath Yatra", short: "Rath", emoji: "🛕", greeting: "Jai Jagannath! Happy Rath Yatra.", look: "temple", group: "india", on: T.rathyatra },
  { title: "Sharad Purnima", short: "Purnima", emoji: "🌕", greeting: "Sharad Purnima: the brightest moon of the year.", look: "moon", group: "india", on: T.sharad },
  { title: "Karwa Chauth", short: "Karwa", emoji: "🌙", greeting: "Happy Karwa Chauth!", look: "moon", group: "india", on: T.karwa },
  { title: "Dhanteras", short: "Dhanteras", emoji: "🪙", greeting: "Happy Dhanteras!", look: "lamp", group: "india", school: true, on: T.dhanteras },
  { title: "Kali Chaudas", short: "Kali Ch.", emoji: "🪔", greeting: "Kali Chaudas: lamps against the dark.", look: "lamp", group: "india", school: true, approx: true, on: T.kalichaudas },
  { title: "Bhai Dooj", short: "Bhai Bij", emoji: "👫", greeting: "Happy Bhai Dooj!", look: "lamp", group: "india", school: true, on: T.bhaidooj },
  { title: "Labh Pancham", short: "Labh P.", emoji: "📒", greeting: "Labh Pancham: a lucky day to open the books.", look: "lamp", group: "india", school: true, approx: true, on: T.labh },
  { title: "Dev Diwali", short: "Dev Diw.", emoji: "🪔", greeting: "Happy Dev Diwali!", look: "lamp", group: "india", on: T.devdiwali },
  { title: "Guru Nanak Jayanti", short: "Gurpurab", emoji: "🙏", greeting: "Happy Gurpurab!", look: "sun", group: "india", school: true, on: T.devdiwali },
  { title: "Chhath Puja", short: "Chhath", emoji: "🌅", greeting: "Happy Chhath Puja!", look: "sun", group: "india", on: T.chhath },
  { title: "Lohri", short: "Lohri", emoji: "🔥", greeting: "Happy Lohri!", look: "harvest", group: "india", on: T.lohri },
  { title: "Pongal", short: "Pongal", emoji: "🍚", greeting: "Happy Pongal!", look: "harvest", group: "india", on: T.pongal },
  { title: "Baisakhi", short: "Baisakhi", emoji: "🌾", greeting: "Happy Baisakhi!", look: "harvest", group: "india", on: T.baisakhi },
  { title: "Onam", short: "Onam", emoji: "🌼", greeting: "Happy Onam!", look: "harvest", group: "india", on: T.onam },
  { title: "Gudi Padwa / Ugadi", short: "Ugadi", emoji: "🎋", greeting: "Happy Gudi Padwa and Ugadi!", look: "bloom", group: "india", on: T.ugadi },
  { title: "Parsi New Year", short: "Navroz", emoji: "🔥", greeting: "Navroz Mubarak!", look: "lamp", group: "india", school: true, approx: true, on: T.parsi },
  { title: "Eid ul-Fitr", major: true, short: "Eid", emoji: "🌙", greeting: "Eid Mubarak!", look: "moon", group: "india", school: true, approx: true, on: T.eidfitr },
  { title: "Eid ul-Adha", major: true, short: "Bakri Eid", emoji: "🌙", greeting: "Eid Mubarak!", look: "moon", group: "india", school: true, approx: true, on: T.eidadha },
  { title: "Muharram", short: "Muharram", emoji: "🌙", greeting: "Muharram (Ashura).", look: "moon", group: "india", school: true, approx: true, on: T.muharram },
  { title: "Milad-un-Nabi", short: "Milad", emoji: "🌙", greeting: "Milad-un-Nabi Mubarak!", look: "moon", group: "india", school: true, approx: true, on: T.milad },
  { title: "Christmas Eve", short: "Xmas Eve", emoji: "🎄", greeting: "Christmas Eve! 🎁", look: "christmas", group: "world", on: "12-24" },
  { title: "New Year's Eve", short: "NYE", emoji: "🥂", greeting: "Last day of the year. Happy New Year's Eve!", look: "newyear", group: "world", on: "12-31" },
  { title: "Good Friday", short: "Good Fri", emoji: "✝️", greeting: "Good Friday.", look: "bloom", group: "world", school: true, on: (y) => [shift(y, easter(y), -2)] },
  { title: "Easter", short: "Easter", emoji: "🐣", greeting: "Happy Easter!", look: "bloom", group: "world", on: (y) => [easter(y)] },
  { title: "Lunar New Year", short: "Lunar NY", emoji: "🧧", greeting: "Happy Lunar New Year!", look: "lantern", group: "world", on: T.lunarny },
  { title: "Thanksgiving (US)", short: "Thanks", emoji: "🦃", greeting: "Happy Thanksgiving!", look: "harvest", group: "world", on: (y) => [nth(y, 11, 4, 4)] },
  { title: "Valentine's Day", short: "Valentine", emoji: "💘", greeting: "Happy Valentine's Day!", look: "heart", group: "fun", on: "02-14" },
  { title: "Women's Day", short: "Women", emoji: "💐", greeting: "Happy Women's Day!", look: "bloom", group: "fun", on: "03-08" },
  { title: "Earth Day", short: "Earth", emoji: "🌍", greeting: "Happy Earth Day!", look: "earth", group: "fun", on: "04-22" },
  { title: "Mother's Day", short: "Mom", emoji: "💐", greeting: "Happy Mother's Day!", look: "bloom", group: "fun", on: (y) => [nth(y, 5, 0, 2)] },
  { title: "Father's Day", short: "Dad", emoji: "👔", greeting: "Happy Father's Day!", look: "sun", group: "fun", on: (y) => [nth(y, 6, 0, 3)] },
  { title: "Teachers' Day", short: "Teachers", emoji: "🍎", greeting: "Happy Teachers' Day!", look: "sun", group: "fun", on: "09-05" },
  { title: "Halloween", short: "Hallow.", emoji: "🎃", greeting: "Happy Halloween! 👻", look: "spooky", group: "fun", on: "10-31" },
];

/** The days from `from` up to the day before `until` (Navratri's nights, up to Dussehra). */
function span(from: string | undefined, until: string | undefined, year: number): string[] {
  if (!from || !until) return [];
  const out: string[] = [];
  for (let i = 0; i < 12; i++) {
    const d = shift(year, from, i);
    if (d >= until) break;
    out.push(d);
  }
  return out;
}

/** Per year: "MM-DD" → the festivals on it, in FESTS order. Built once per year asked for. */
const byYear = new Map<number, Map<string, Special[]>>();
function yearIndex(year: number): Map<string, Special[]> {
  let idx = byYear.get(year);
  if (idx) return idx;
  idx = new Map();
  for (const f of FESTS) {
    const days = typeof f.on === "string" ? [f.on] : typeof f.on === "function" ? f.on(year) : f.on[year] ? [f.on[year]] : [];
    const s: Special = { kind: f.look, title: f.title, short: f.short, emoji: f.emoji, greeting: f.greeting, group: f.group, school: f.school, approx: f.approx, major: f.major };
    for (const d of days) idx.set(d, [...(idx.get(d) ?? []), s]);
  }
  byYear.set(year, idx);
  return idx;
}

/** The festivals on a "YYYY-MM-DD" day, in the groups that are on (all by default). */
export function festivalsOn(day: string, groups?: Partial<Record<FestGroup, boolean>>): Special[] {
  const list = yearIndex(Number(day.slice(0, 4))).get(day.slice(5)) ?? [];
  return groups ? list.filter((f) => groups[f.group!] !== false) : list.slice();
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
export function specialsOn(day: string, personal: PersonalDate[], groups?: Partial<Record<FestGroup, boolean>>): Special[] {
  const out = festivalsOn(day, groups);
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
    // "8 Sep · Ganpati at home 🐘": an own festival keeps its emoji as the badge.
    const own = p.title.match(/\p{Extended_Pictographic}/u)?.[0];
    const short = p.title.replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, "").trim().split(/\s+/)[0]?.slice(0, 9);
    out.push({ kind: p.kind, title: p.title, short, emoji: (p.kind === "special" && own) || EMOJI[p.kind], greeting, years: years || undefined });
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
