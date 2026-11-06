/** How far a day is from today, in calendar years, months and days (YYYY-MM-DD keys). */
export interface Relative {
  years: number;
  months: number;
  days: number;
  /** Whole days between them, always ≥ 0. */
  total: number;
  future: boolean;
}

const parse = (d: string) => {
  const [y, m, day] = d.split("-").map(Number);
  return { y, m, d: day };
};
const daysIn = (y: number, m: number) => new Date(y, m, 0).getDate();

export function relativeTo(day: string, today: string): Relative {
  const future = day > today;
  const [a, b] = future ? [parse(today), parse(day)] : [parse(day), parse(today)];
  // Whole months from a to b (a month from 31 Jan is the end of February), then the days left over.
  let months = (b.y - a.y) * 12 + (b.m - a.m);
  if (b.d < a.d) months -= 1;
  const am = a.m - 1 + months;
  const ay = a.y + Math.floor(am / 12);
  const mm = ((am % 12) + 12) % 12;
  const anchor = Date.UTC(ay, mm, Math.min(a.d, daysIn(ay, mm + 1)));
  const days = Math.round((Date.UTC(b.y, b.m - 1, b.d) - anchor) / 86_400_000);
  const years = Math.floor(months / 12);
  months %= 12;
  const total = Math.round(Math.abs(Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86_400_000);
  return { years, months, days, total, future };
}

const unit = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** "2 years, 3 months and 4 days ago", "in 5 days", "Today", "Yesterday", "Tomorrow". */
export function relativeLabel(day: string, today: string): string {
  if (day === today) return "Today";
  const r = relativeTo(day, today);
  if (r.total === 1) return r.future ? "Tomorrow" : "Yesterday";
  const parts = [r.years && unit(r.years, "year"), r.months && unit(r.months, "month"), r.days && unit(r.days, "day")].filter(Boolean) as string[];
  const text = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0];
  return r.future ? `in ${text}` : `${text} ago`;
}
