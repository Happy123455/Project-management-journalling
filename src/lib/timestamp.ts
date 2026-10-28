const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const pad = (n: number) => String(n).padStart(2, "0");

/** One-click timestamp, e.g. "27,October,2026 Tuesday (22:04:26)". */
export function formatTimestamp(date: Date): string {
  const day = `${date.getDate()},${MONTHS[date.getMonth()]},${date.getFullYear()}`;
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  return `${day} ${WEEKDAYS[date.getDay()]} (${time})`;
}

/** Local calendar day as YYYY-MM-DD, used as the key of a daily page. */
export function dayKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Shift a YYYY-MM-DD key by whole days. */
export function addDays(key: string, days: number): string {
  const [y, m, d] = key.split("-").map(Number);
  return dayKey(new Date(y, m - 1, d + days));
}

/** Heading for a daily page, e.g. "Tuesday, 27 October 2026". */
export function dayTitle(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return `${WEEKDAYS[date.getDay()]}, ${d} ${MONTHS[m - 1]} ${y}`;
}
