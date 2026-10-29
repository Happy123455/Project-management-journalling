import type React from "react";
import { dayKey, dayTitle } from "../lib/timestamp";
import { docText } from "../lib/words";
import type { DayPage } from "../store";

/** First line of a page, cut short for a one-line preview. */
function snippet(page: DayPage): string {
  const line = docText(page.content).split("\n").find((l) => l.trim()) ?? "";
  return line.length > 80 ? line.slice(0, 79) + "…" : line;
}

interface DueProps {
  pages: DayPage[];
  onPick: (day: string) => void;
  onDone: (day: string) => void;
}

/** Reminders whose day has come, highlighted at the top of today's page until marked done. */
export function DueReminders({ pages, onPick, onDone }: DueProps) {
  if (!pages.length) return null;
  return (
    <section className="reminders due">
      <h2>🔔 Reminders</h2>
      <ul>
        {pages.map((p) => (
          <li key={p.day}>
            <button type="button" className="reminder-open" onClick={() => onPick(p.day)}>
              <span className="reminder-day">{dayTitle(p.day)}</span>
              <span className="reminder-text">{snippet(p)}</span>
            </button>
            <button type="button" className="reminder-done" onClick={() => onDone(p.day)}>✓ Done</button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Reminders still ahead, soonest first. */
/** Whole days from `from` to `to` (YYYY-MM-DD). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T12:00:00`) - Date.parse(`${from}T12:00:00`)) / 86_400_000);
}

const BAR_MAX = 30;

/** "N days left" and a dash per day (at most 30, then "+N"), warmer as the day gets close. */
function Countdown({ day }: { day: string }) {
  const left = daysBetween(dayKey(new Date()), day);
  const dashes = Math.min(left, BAR_MAX);
  // 0 = due now (red), 1 = a month or more away (cool blue).
  const far = Math.min(1, left / BAR_MAX);
  const hue = Math.round(far * 210);
  return (
    <span className="countdown" style={{ "--countdown-hue": hue } as React.CSSProperties}>
      <span className="countdown-days">{left === 1 ? "1 day left" : `${left} days left`}</span>
      <span className="countdown-bar" aria-hidden>
        {"-".repeat(dashes)}
        {left > BAR_MAX && <span className="countdown-more">+{left - BAR_MAX}</span>}
      </span>
    </span>
  );
}

export function Upcoming({ pages, onPick }: { pages: DayPage[]; onPick: (day: string) => void }) {
  if (!pages.length) return null;
  return (
    <section className="reminders">
      <h2>Coming up</h2>
      <ul>
        {pages.map((p) => (
          <li key={p.day}>
            <button type="button" className="reminder-open" onClick={() => onPick(p.day)}>
              <span className="reminder-day">{dayTitle(p.day)}</span>
              <span className="reminder-text">{snippet(p)}</span>
              <Countdown day={p.day} />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
