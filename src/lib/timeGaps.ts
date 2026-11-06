import { TIMESTAMP_RE } from "./timestamp";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** A timestamp's moment (ms), from "27,October,2026 Tuesday (22:04:26)"; null if it isn't one. */
export function timestampTime(text: string): number | null {
  const m = new RegExp(TIMESTAMP_RE.source).exec(text);
  if (!m) return null;
  const month = MONTHS.indexOf(m[2]);
  if (month < 0) return null;
  const t = new Date(Number(m[3]), month, Number(m[1]), Number(m[5]), Number(m[6]), Number(m[7])).getTime();
  return Number.isFinite(t) ? t : null;
}

/** "45s", "12m", "1h 23m", "2d 3h": how long between two timestamps, to the useful precision. */
export function formatGap(ms: number): string {
  const s = Math.round(Math.abs(ms) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

export interface Stamp {
  /** Where it is in the note (start of the timestamp text). */
  pos: number;
  time: number;
  /** The text of its line after the timestamp (what happened then). */
  label: string;
}

/**
 * Every timestamp in a note, in the order they're written, from (position, line text) pairs.
 * The label is what follows the timestamp on its line.
 */
export function stampsIn(lines: { pos: number; text: string }[]): Stamp[] {
  const out: Stamp[] = [];
  const re = new RegExp(TIMESTAMP_RE.source, "g");
  for (const { pos, text } of lines) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const time = timestampTime(m[0]);
      if (time === null) continue;
      const rest = text.slice(m.index + m[0].length);
      const next = rest.search(new RegExp(TIMESTAMP_RE.source));
      const label = (next >= 0 ? rest.slice(0, next) : rest).replace(/^[\s:–—-]+/, "").replace(/\s+/g, " ").trim().slice(0, 60);
      out.push({ pos: pos + m.index, time, label });
    }
  }
  return out;
}

/** Where each stamp sits on a rail from the earliest (0) to the latest (1), by real time. */
export function railPlaces(stamps: Stamp[]): number[] {
  if (!stamps.length) return [];
  const times = stamps.map((s) => s.time);
  const lo = Math.min(...times);
  const hi = Math.max(...times);
  return times.map((t) => (hi === lo ? 0.5 : (t - lo) / (hi - lo)));
}
