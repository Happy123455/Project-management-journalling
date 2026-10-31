import React, { memo, useEffect, useRef, useState, type CSSProperties } from "react";
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

/** The calendars' shading: words written (purple), or matches for the current search (yellow). */
export interface Shading {
  counts: Counts;
  /** Set while a search is active. */
  search: boolean;
}

/** The highest count among days starting with `prefix`; searches count future days too. */
const maxFor = (s: Shading, prefix: string, today: string) =>
  s.search ? Object.entries(s.counts).reduce((m, [d, n]) => (d.startsWith(prefix) ? Math.max(m, n) : m), 0) : maxWords(s.counts, prefix, today);

interface GridProps {
  year: number;
  month: number;
  counts: Counts;
  max: number;
  search?: boolean;
  selected: string;
  today: string;
  onPick: (day: string) => void;
  /** Show only the week that holds `selected`. */
  weekOnly?: boolean;
  mini?: boolean;
}

/** One month as a heat map: each day is filled purple, brighter the more was written. */
/** A month's grid. Redrawn only when what it shows changes (its pick handler may be a fresh copy each time). */
export const MonthGrid = memo(MonthGridView, (a, b) =>
  (Object.keys(a) as (keyof GridProps)[]).every((k) => typeof a[k] === "function" || a[k] === b[k]),
);

function MonthGridView({ year, month, counts, max, search, selected, today, onPick, weekOnly, mini }: GridProps) {
  let weeks = monthWeeks(year, month);
  if (weekOnly) weeks = weeks.filter((w) => w.includes(selected)).slice(0, 1);
  return (
    <div className={mini ? "month-grid mini" : "month-grid"}>
      {WEEKDAY_LETTERS.map((l, i) => <span key={i} className="weekday">{l}</span>)}
      {weeks.flat().map((d, i) => {
        if (!d) return <span key={i} />;
        const words = counts[d] ?? 0;
        const reminder = !search && d > today && words > 0;
        const classes = ["cal-day", d === selected && "selected", d === today && "today", reminder && "reminder"]
          .filter(Boolean)
          .join(" ");
        return (
          <button
            key={d}
            type="button"
            className={classes}
            style={{ "--heat": reminder ? 0 : heat(words, max) } as CSSProperties}
            title={reminder ? `${d}: reminder` : search ? `${d}: ${words} matches` : `${d}: ${words} words`}
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
  shading: Shading;
  today: string;
  collapsed: boolean;
  /** Folded further to a thin bar while typing. */
  compact?: boolean;
  /** Open (true) or fold (false) the month; no argument flips it. */
  onToggle: (open?: boolean) => void;
  onPick: (day: string) => void;
  onOpenYear: () => void;
}

/** Month heat map at the top of the page; shrinks to the current week while writing. */
export function MonthCalendar({ day, shading, today, collapsed, compact, onToggle, onPick, onOpenYear, actions, below }: MonthProps & { actions?: React.ReactNode; below?: React.ReactNode }) {
  const [year, month] = day.split("-").map(Number);
  // Pull the strip down to open the month, push the month up to fold it.
  const drag = useRef<{ y: number; x: number } | null>(null);
  const section = useRef<HTMLElement>(null);
  // Opened while pinned at the top of a scrolled note: the month floats over the note as a sheet
  // (fully below the status bar), and the note underneath doesn't move.
  const [floating, setFloating] = useState(false);
  const stripHeight = useRef(0);
  // Where the strip was: the sheet opens at exactly its left edge and width (it used to snap to the
  // window's width and look like it narrowed on the Mac, where the side menus take room).
  const stripBox = useRef<{ left: number; width: number } | null>(null);
  const lastToggle = useRef(0);
  const toggle = (open: boolean) => {
    // Quick repeated taps count once (each one re-lays out the month).
    if (Date.now() - lastToggle.current < 350) return;
    lastToggle.current = Date.now();
    if (open) {
      const el = section.current;
      stripHeight.current = el?.offsetHeight ?? 0;
      const box = el?.getBoundingClientRect();
      stripBox.current = box ? { left: box.left, width: box.width } : null;
      // Pinned under the status bar (phone) or under the Mac's fixed header.
      setFloating(!!el && window.scrollY > 0 && el.getBoundingClientRect().top < 72);
    }
    onToggle(open);
  };
  useEffect(() => {
    if (collapsed) setFloating(false);
  }, [collapsed]);
  const sheet = floating && !collapsed;
  const titleTouch = useRef<{ x: number; y: number } | null>(null);
  const titleSwiped = useRef(0);
  /** Same day of the month before/after (the last day when that month is shorter). */
  const shiftMonth = (by: number) => {
    const d = Number(day.slice(8, 10));
    const last = new Date(year, month - 1 + by + 1, 0).getDate();
    onPick(dayKey(new Date(year, month - 1 + by, Math.min(d, last))));
  };
  // The month scrolled to its end: Coming up is folded and there is nothing more to show.
  const endedAt = useRef(0);
  const atEnd = () => {
    const el = section.current;
    return !!el && el.scrollHeight > el.clientHeight + 4 && el.scrollTop + el.clientHeight >= el.scrollHeight - 2 && Date.now() - endedAt.current > 250;
  };
  // Mac: wheeling on past the end folds the month to its week, the same as the swipe.
  const wheelPast = useRef(0);
  return (
    <>
      {sheet && <div className="cal-spacer" style={{ height: stripHeight.current }} />}
      {sheet && <div className="cal-scrim" onClick={() => toggle(false)} />}
      <section
        ref={section}
        className={`month-calendar${collapsed ? " collapsed" : ""}${compact ? " compact" : ""}${sheet ? " floating" : ""}${shading.search ? " search-mode" : ""}`}
        style={sheet && stripBox.current ? { left: stripBox.current.left, width: stripBox.current.width, right: "auto", maxWidth: "none", margin: 0, boxSizing: "border-box" } : undefined}
        // A day opens that day; anywhere else (not a button) opens the week into the month, or folds the month back.
        onClick={(e) => {
          const t = e.target as HTMLElement;
          if (t.closest("button, a, input, .reminders")) return;
          toggle(collapsed);
        }}
        onScroll={(e) => {
          const el = e.currentTarget;
          // Only counts as "at the end" a moment after arriving there, so the scroll itself doesn't fold it.
          if (el.scrollTop + el.clientHeight < el.scrollHeight - 2) endedAt.current = Date.now();
          wheelPast.current = 0;
        }}
        onWheel={(e) => {
          if (collapsed || e.deltaY <= 0 || !atEnd()) return void (wheelPast.current = 0);
          wheelPast.current += e.deltaY;
          if (wheelPast.current > 160) {
            wheelPast.current = 0;
            toggle(false);
          }
        }}
        onTouchStart={(e) => (drag.current = { y: e.touches[0].clientY, x: e.touches[0].clientX })}
        onTouchEnd={(e) => {
          const start = drag.current;
          drag.current = null;
          if (!start) return;
          const dy = e.changedTouches[0].clientY - start.y;
          if (Math.abs(dy) < 30 || Math.abs(dy) < Math.abs(e.changedTouches[0].clientX - start.x) * 1.5) return;
          if (dy > 0 && collapsed) toggle(true);
          // Not while the month's own list is being scrolled; but a swipe up at the end of it (Coming up
          // already folded) carries on into the week view.
          else if (dy < 0 && !collapsed && (atEnd() || (!(e.target as HTMLElement).closest?.(".reminders") && !(section.current && section.current.scrollTop > 0)))) toggle(false);
        }}
      >
        <div className="cal-bar">
          {!collapsed && <button type="button" className="cal-month-step" onClick={() => shiftMonth(-1)} aria-label="Previous month">‹</button>}
          <button
            type="button"
            className="cal-title"
            onClick={() => {
              if (Date.now() - titleSwiped.current < 400) return;
              toggle(collapsed);
            }}
            aria-expanded={!collapsed}
            // A quick swipe left/right on the month name changes the month.
            onTouchStart={(e) => {
              e.stopPropagation();
              titleTouch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
            }}
            onTouchMove={(e) => e.stopPropagation()}
            onTouchEnd={(e) => {
              e.stopPropagation();
              const start = titleTouch.current;
              titleTouch.current = null;
              if (!start) return;
              const dx = e.changedTouches[0].clientX - start.x;
              const dy = e.changedTouches[0].clientY - start.y;
              if (Math.abs(dx) > 36 && Math.abs(dx) > Math.abs(dy) * 1.5) {
                titleSwiped.current = Date.now();
                shiftMonth(dx < 0 ? 1 : -1);
              } else if (Math.abs(dy) >= 30) {
                // Vertical: the usual open / fold.
                if (dy > 0 && collapsed) toggle(true);
                else if (dy < 0 && !collapsed) toggle(false);
                titleSwiped.current = Date.now();
              }
            }}
          >
            {MONTH_NAMES[month - 1]} {year} {collapsed ? "▾" : "▴"}
          </button>
          {!collapsed && <button type="button" className="cal-month-step" onClick={() => shiftMonth(1)} aria-label="Next month">›</button>}
          {/* Menu, search and chat stay within reach, on the week strip and in the month. */}
          {actions && <span className="cal-actions">{actions}</span>}
          <button type="button" className="cal-year" onClick={onOpenYear}>
            Year ›
          </button>
        </div>
        <MonthGrid
          key={collapsed ? "week" : "month"}
          year={year}
          month={month - 1}
          counts={shading.counts}
          max={maxFor(shading, day.slice(0, 7), today)}
          search={shading.search}
          selected={day}
          today={today}
          onPick={onPick}
          weekOnly={collapsed}
        />
        {/* "Coming up" opens with the month, wherever the calendar is pinned. */}
        {!collapsed && below}
      </section>
    </>
  );
}

interface YearProps {
  year: number;
  day: string;
  shading: Shading;
  today: string;
  open: boolean;
  onClose: () => void;
  onPick: (day: string) => void;
  onYear: (year: number) => void;
  /** Swipe left on the year: everything coming up. */
  onUpcoming?: () => void;
}

/** Slide-in panel with all twelve months; shades are relative to the busiest day of the year. */
export function YearPanel({ year, day, shading, today, open, onClose, onPick, onYear, onUpcoming }: YearProps) {
  const max = maxFor(shading, String(year), today);
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
        className={`year-panel${open ? " open" : ""}${shading.search ? " search-mode" : ""}`}
        aria-hidden={!open}
        onTouchStart={(e) => (touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY })}
        onTouchEnd={(e) => {
          const start = touch.current;
          touch.current = null;
          if (!start) return;
          const dx = e.changedTouches[0].clientX - start.x;
          const dy = e.changedTouches[0].clientY - start.y;
          if (Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
          if (dx > 0) onClose();
          else onUpcoming?.();
        }}
      >
        <header className="year-header">
          <button type="button" onClick={() => onYear(year - 1)} aria-label="Previous year">‹</button>
          <h2>{year}</h2>
          <button type="button" onClick={() => onYear(year + 1)} aria-label="Next year">›</button>
          {onUpcoming && <button type="button" className="year-upcoming" onClick={onUpcoming} aria-label="Coming up">Coming up ›</button>}
          <button type="button" className="close" onClick={onClose} aria-label="Close year view">✕</button>
        </header>
        {/* Twelve months are only drawn while the year view is open. */}
        {open && <div className="year-grid">
          {MONTH_NAMES.map((name, m) => (
            <div key={name} className="year-month">
              <h3>{name}</h3>
              <MonthGrid
                year={year}
                month={m}
                counts={shading.counts}
                max={max}
                search={shading.search}
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
        </div>}
      </aside>
    </>
  );
}
