// The Gantt chart's time scale: how wide a day is (zoom), which ticks and bands show at that zoom
// (hours → days → weeks → months), and keeping the moment under the fingers in place while zooming.
import { addDays, dayKey } from "./timestamp";

export const DAY_MS = 24 * 3_600_000;
/** Pixels per day: from ~4 months on a phone screen to an hour per 60 px. */
export const MIN_PX_PER_DAY = 2.5;
export const MAX_PX_PER_DAY = 1440;
export const DEFAULT_PX_PER_DAY = 46;

export type Level = "hour" | "day" | "week" | "month";

/** The named zooms the buttons jump to. */
export const PRESETS: { level: Level; label: string; px: number }[] = [
  { level: "hour", label: "Hours", px: 480 },
  { level: "day", label: "Days", px: 46 },
  { level: "week", label: "Weeks", px: 14 },
  { level: "month", label: "Months", px: 4 },
];

export function levelFor(px: number): Level {
  if (px >= 240) return "hour";
  if (px >= 28) return "day";
  if (px >= 7) return "week";
  return "month";
}

export const clampZoom = (px: number, min = MIN_PX_PER_DAY) => Math.min(MAX_PX_PER_DAY, Math.max(min, px));

const midnightOf = (t: number) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export interface Tick {
  t: number;
  label: string;
  sub?: string;
  today?: boolean;
  weekend?: boolean;
}
export interface Band {
  from: number;
  to: number;
  kind: "weekend" | "alt" | "plain";
  past?: boolean;
}
export interface Scale {
  level: Level;
  major: Tick[];
  minor: Tick[];
  bands: Band[];
}

/** Hours between hour ticks so labels stay at least ~36 px apart. */
const hourStep = (px: number) => [1, 2, 3, 6, 12].find((h) => (px / 24) * h >= 36) ?? 12;

/**
 * Ticks and background bands between `from` and `to` (ms) at `px` per day. Only what lies inside
 * [from, to] is made, so the caller passes the visible stretch (plus a margin) when zoomed far in.
 */
export function scaleTicks(from: number, to: number, px: number, now: number): Scale {
  const level = levelFor(px);
  const major: Tick[] = [];
  const minor: Tick[] = [];
  const bands: Band[] = [];
  const today = dayKey(new Date(now));
  const startDay = dayKey(new Date(from));
  const guard = 2000;
  if (level === "hour" || level === "day") {
    for (let d = startDay, n = 0; n < guard; d = addDays(d, 1), n++) {
      const t = midnightOf(new Date(`${d}T00:00:00`).getTime());
      if (t > to) break;
      const date = new Date(t);
      const weekend = date.getDay() === 0 || date.getDay() === 6;
      const next = midnightOf(t + DAY_MS + 3_600_000 * 3);
      bands.push({ from: t, to: next, kind: weekend ? "weekend" : "plain", past: next <= midnightOf(now) });
      if (level === "hour") {
        major.push({ t, label: `${WEEKDAYS[date.getDay()]} ${date.getDate()} ${MONTHS[date.getMonth()]}`, today: d === today, weekend });
        const step = hourStep(px);
        for (let h = 0; h < 24; h += step) {
          const at = new Date(date);
          at.setHours(h);
          minor.push({ t: at.getTime(), label: `${String(h).padStart(2, "0")}:00` });
        }
      } else {
        if (date.getDate() === 1 || d === startDay) major.push({ t, label: `${MONTHS[date.getMonth()]} ${date.getFullYear()}` });
        minor.push({ t, label: String(date.getDate()), sub: WEEKDAYS[date.getDay()], today: d === today, weekend });
      }
    }
  } else if (level === "week") {
    // Weeks from Monday.
    const s = new Date(midnightOf(from));
    s.setDate(s.getDate() - ((s.getDay() + 6) % 7));
    let alt = false;
    for (let n = 0; n < guard; n++) {
      const t = s.getTime();
      if (t > to) break;
      const end = new Date(s);
      end.setDate(end.getDate() + 7);
      bands.push({ from: t, to: end.getTime(), kind: alt ? "alt" : "plain", past: end.getTime() <= midnightOf(now) });
      alt = !alt;
      minor.push({ t, label: `${s.getDate()}`, sub: MONTHS[s.getMonth()], today: now >= t && now < end.getTime() });
      s.setDate(s.getDate() + 7);
    }
    const m = new Date(midnightOf(from));
    m.setDate(1);
    for (let n = 0; n < guard && m.getTime() <= to; n++) {
      major.push({ t: Math.max(m.getTime(), from), label: `${MONTHS[m.getMonth()]} ${m.getFullYear()}` });
      m.setMonth(m.getMonth() + 1);
    }
  } else {
    const m = new Date(midnightOf(from));
    m.setDate(1);
    let alt = false;
    for (let n = 0; n < guard && m.getTime() <= to; n++) {
      const t = m.getTime();
      const end = new Date(m);
      end.setMonth(end.getMonth() + 1);
      bands.push({ from: t, to: end.getTime(), kind: alt ? "alt" : "plain", past: end.getTime() <= midnightOf(now) });
      alt = !alt;
      minor.push({ t, label: MONTHS[m.getMonth()], today: now >= t && now < end.getTime() });
      if (m.getMonth() === 0 || n === 0) major.push({ t: Math.max(t, from), label: String(m.getFullYear()) });
      m.setMonth(m.getMonth() + 1);
    }
  }
  return { level, major, minor, bands };
}

/**
 * Where to scroll after a zoom so the moment that was under `anchorX` (px from the chart's left
 * edge in view) stays under it: the new scrollLeft.
 */
export function anchoredScroll(scrollLeft: number, anchorX: number, oldPx: number, newPx: number): number {
  const days = (scrollLeft + anchorX) / oldPx;
  return Math.max(0, days * newPx - anchorX);
}

/** A deadline that belongs in History: marked done or archived, past its due time, or all its steps done. */
export function inHistory(t: { endAt: number; info: { status?: string; steps?: { done?: boolean }[] } }, now: number): boolean {
  if (t.info.status) return true;
  if (t.endAt <= now) return true;
  const steps = t.info.steps ?? [];
  return steps.length > 0 && steps.every((s) => s.done);
}
