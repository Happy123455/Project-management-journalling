// The days a voice request can name, worked out here so the model never has to count
// (25 Nov, Hapi said "in 2 days' note" and the agent wrote into today's). The agent's prompt
// carries this little calendar; the model only has to pick a line.
import { addDays, dayKey } from "../lib/timestamp";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const dateOf = (key: string) => {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
};

/** "Fri 27 Nov" for a YYYY-MM-DD key (what the bubble says it did). */
export function shortDay(key: string, today?: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return key;
  if (today) {
    const off = Math.round((dateOf(key).getTime() - dateOf(today).getTime()) / 86_400_000);
    if (off === 0) return "today";
    if (off === 1) return "tomorrow";
    if (off === -1) return "yesterday";
  }
  const d = dateOf(key);
  return `${WEEKDAYS[d.getDay()].slice(0, 3)} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/** The lines of the little calendar: "in 2 days (day after tomorrow): Friday 2026-11-27". */
export function dayLines(now: Date): string[] {
  const today = dayKey(now);
  const name = (k: string) => `${WEEKDAYS[dateOf(k).getDay()]} ${k}`;
  const out = [`today: ${name(today)}`, `yesterday: ${name(addDays(today, -1))}`];
  for (let n = 2; n <= 3; n++) out.push(`${n} days ago: ${name(addDays(today, -n))}`);
  out.push(`tomorrow: ${name(addDays(today, 1))}`);
  out.push(`in 2 days / the day after tomorrow / "2 days' note": ${name(addDays(today, 2))}`);
  for (let n = 3; n <= 7; n++) out.push(`in ${n} days: ${name(addDays(today, n))}`);
  const wd = now.getDay();
  // Weeks run Monday to Sunday: "Friday of next week" is in the week after this one.
  const daysToSunday = (7 - wd) % 7;
  for (let k = 1; k <= 7; k++) {
    const key = addDays(today, k);
    const d = WEEKDAYS[(wd + k) % 7];
    const nextWeek = k <= daysToSunday ? addDays(key, 7) : key;
    out.push(`${d} (the coming one): ${key}; ${d} of next week: ${nextWeek}`);
  }
  for (let k = 1; k <= 7; k++) {
    const key = addDays(today, -k);
    out.push(`last ${WEEKDAYS[(wd - k + 7) % 7]}: ${key}`);
  }
  out.push(`next week (Monday): ${addDays(today, ((8 - wd) % 7) || 7)}`);
  return out;
}

/** The calendar block for an agent's prompt. */
export function dayCheatSheet(now: Date, onScreen?: string | null): string {
  const screen = onScreen ? (/^\d{4}-\d{2}-\d{2}$/.test(onScreen) ? `the day note ${WEEKDAYS[dateOf(onScreen).getDay()]} ${onScreen}` : `the page "${onScreen}"`) : "today's note";
  return `Days (use these, don't count yourself):\n${dayLines(now).map((l) => `- ${l}`).join("\n")}\nOn screen now: ${screen}.`;
}
