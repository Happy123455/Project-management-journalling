import { useEffect, useRef, type CSSProperties } from "react";
import { dayKey } from "../lib/timestamp";
import { heat } from "../lib/words";

export const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const WEEKDAY_LETTERS = ["S", "M", "T", "W", "T", "F", "S"];

type Counts = Record<string, number>;

/** Weeks of a month as rows of seven day keys, with null for the padding cells. */
function monthWeeks(year: number, month: number): (string | null)[][] {
  const first = new Date(year, month, 1).getDay();
  const length = new Date(year, month + 1, 0).getDate();
  const cells: (string | null)[] = Array(first).fill(null);
  for (let d = 1; d <= length; d++) cells.push(dayKey(new Date(year, month, d)));
  while (cells.length % 7) cells.push(null);
  return Array.from({ length: cells.length / 7 }, (_, i) => cells.slice(i * 7, i * 7 + 7));
}

/**
 * The busiest day's word count among the keys starting with `prefix` ("2026-10" or "2026").
 * Days after `today` are reminders, not writing done, so they don't count.
 */
export function maxWords(counts: Counts, prefix: string, today: string): number {
  return Object.entries(counts).reduce(
    (max, [d, n]) => (d.startsWith(prefix) && d <= today ? Math.max(max, n) : max),
    0,
  );
}

interface GridProps {
  year: number;
  month: number;
  counts: Counts;
  max: number;
  selected: string;
  today: string;
  onPick: (day: string) => void;
  /** Show only the week that holds `selected`. */
  weekOnly?: boolean;
  mini?: boolean;
}

/** One month as a heat map: each day is filled purple, brighter the more was written. */
export function MonthGrid({ year, month, counts, max, selected, today, onPick, weekOnly, mini }: GridProps) {
  let weeks = monthWeeks(year, month);
  if (weekOnly) weeks = weeks.filter((w) => w.includes(selected)).slice(0, 1);
  return (
    <div className={mini ? "month-grid mini" : "month-grid"}>
      {WEEKDAY_LETTERS.map((l, i) => <span key={i} className="weekday">{l}</span>)}
      {weeks.flat().map((d, i) => {
        if (!d) return <span key={i} />;
        const words = counts[d] ?? 0;
        const reminder = d > today && words > 0;
        const classes = ["cal-day", d === selected && "selected", d === today && "today", reminder && "reminder"]
          .filter(Boolean)
          .join(" ");
        return (
          <button
            key={d}
            type="button"
            className={classes}
            style={{ "--heat": reminder ? 0 : heat(words, max) } as CSSProperties}
            title={reminder ? `${d}: reminder` : `${d}: ${words} words`}
            onClick={() => onPick(d)}
          >
            {Number(d.slice(8))}
          </button>
        );
      })}
    </div>
  );
}

interface MonthProps {
  day: string;
  counts: Counts;
  today: string;
  collapsed: boolean;
  onToggle: () => void;
  onPick: (day: string) => void;
  onOpenYear: () => void;
}

/** Month heat map at the top of the page; shrinks to the current week while writing. */
export function MonthCalendar({ day, counts, today, collapsed, onToggle, onPick, onOpenYear }: MonthProps) {
  const [year, month] = day.split("-").map(Number);
  return (
    // While shrunk to one week, a tap anywhere on it opens the whole month (days can't be picked yet).
    <section
      className={collapsed ? "month-calendar collapsed" : "month-calendar"}
      onClick={collapsed ? onToggle : undefined}
    >
      <div className="cal-bar">
        <button
          type="button"
          className="cal-title"
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
          aria-expanded={!collapsed}
        >
          {MONTH_NAMES[month - 1]} {year} {collapsed ? "▾" : "▴"}
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onOpenYear();
          }}
        >
          Year ›
        </button>
      </div>
      <MonthGrid
        year={year}
        month={month - 1}
        counts={counts}
        max={maxWords(counts, day.slice(0, 7), today)}
        selected={day}
        today={today}
        onPick={collapsed ? () => {} : onPick}
        weekOnly={collapsed}
      />
    </section>
  );
}

interface YearProps {
  year: number;
  day: string;
  counts: Counts;
  today: string;
  open: boolean;
  onClose: () => void;
  onPick: (day: string) => void;
  onYear: (year: number) => void;
}

/** Slide-in panel with all twelve months; shades are relative to the busiest day of the year. */
export function YearPanel({ year, day, counts, today, open, onClose, onPick, onYear }: YearProps) {
  const max = maxWords(counts, String(year), today);
  const touch = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <>
      <div className={open ? "year-backdrop open" : "year-backdrop"} onClick={onClose} />
      <aside
        className={open ? "year-panel open" : "year-panel"}
        aria-hidden={!open}
        onTouchStart={(e) => (touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY })}
        onTouchEnd={(e) => {
          const start = touch.current;
          touch.current = null;
          if (!start) return;
          const dx = e.changedTouches[0].clientX - start.x;
          const dy = e.changedTouches[0].clientY - start.y;
          if (dx > 70 && Math.abs(dx) > Math.abs(dy) * 1.5) onClose();
        }}
      >
        <header className="year-header">
          <button type="button" onClick={() => onYear(year - 1)} aria-label="Previous year">‹</button>
          <h2>{year}</h2>
          <button type="button" onClick={() => onYear(year + 1)} aria-label="Next year">›</button>
          <button type="button" className="close" onClick={onClose} aria-label="Close year view">✕</button>
        </header>
        <div className="year-grid">
          {MONTH_NAMES.map((name, m) => (
            <div key={name} className="year-month">
              <h3>{name}</h3>
              <MonthGrid
                year={year}
                month={m}
                counts={counts}
                max={max}
                selected={day}
                today={today}
                onPick={(d) => {
                  onPick(d);
                  onClose();
                }}
                mini
              />
            </div>
          ))}
        </div>
      </aside>
    </>
  );
}
