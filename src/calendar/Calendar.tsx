import React, { memo, useEffect, useRef, useState, type CSSProperties } from "react";
import { dayKey } from "../lib/timestamp";
import { heat } from "../lib/words";
import { useEscapeToClose } from "../ui/useEscapeToClose";
import { haptic } from "../lib/haptic";

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
  const toggle = (open: boolean, force = false) => {
    // Quick repeated taps count once (each one re-lays out the month).
    if (!force && Date.now() - lastToggle.current < 350) return;
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
  // Pulling the week strip down: the month opens under the finger and follows it (not a snap at the end).
  const pull = useRef<{ x: number; y: number; t: number; base: number; on: boolean; dy: number } | null>(null);
  const pullFrame = useRef(0);
  const [pulling, setPulling] = useState(false);
  const endPull = (dy: number, t: number) => {
    const p = pull.current;
    pull.current = null;
    const el = section.current;
    if (!p?.on || !el) return false;
    cancelAnimationFrame(pullFrame.current);
    const full = Math.min(el.scrollHeight, window.innerHeight - 16);
    const fast = dy / Math.max(1, t - p.t) > 0.5;
    const open = dy > 0 && (fast || dy > (full - p.base) * 0.33);
    el.style.transition = "max-height 0.28s cubic-bezier(0.22, 1, 0.36, 1)";
    el.style.maxHeight = `${open ? full : p.base}px`;
    haptic(open ? "edge" : "tick", 0.6);
    window.setTimeout(() => {
      el.style.transition = "";
      el.style.maxHeight = "";
      setPulling(false);
      if (!open) toggle(false, true);
    }, 290);
    return true;
  };
  // React's touch handlers can't stop the page scrolling, so a real listener does: while the strip is
  // pulled down, the finger only opens the month (the note underneath stays where it is).
  //
  // The pull is followed on the touched element itself, not the section: opening swaps the week row
  // for the month, and the touched day leaves the page. Its later touch events then never reach the
  // section (nor React), which left the month stuck half open. The element itself still gets them.
  const pullMove = (e: TouchEvent) => {
    const p = pull.current;
    const el = section.current;
    if (!p || !el) return;
    const dy = e.touches[0].clientY - p.y;
    const dx = e.touches[0].clientX - p.x;
    if (e.cancelable && (p.on || (dy > 2 && dy >= Math.abs(dx)))) e.preventDefault();
    if (!p.on) {
      if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy)) return void (pull.current = null);
      if (dy < 10 || dy < Math.abs(dx) * 1.2) return;
      p.on = true;
      setPulling(true);
      el.style.transition = "none";
      el.style.maxHeight = `${p.base}px`;
      haptic("tap", 0.4);
      toggle(true, true);
    }
    p.dy = dy;
    cancelAnimationFrame(pullFrame.current);
    pullFrame.current = requestAnimationFrame(() => {
      el.style.maxHeight = `${Math.max(p.base, p.base + p.dy)}px`;
    });
  };
  const pullEnd = (e: TouchEvent, cancelled: boolean) => {
    const p = pull.current;
    if (!p?.on) return void (pull.current = null);
    pulledAt.current = Date.now();
    drag.current = null;
    endPull(cancelled ? p.dy : (e.changedTouches[0]?.clientY ?? p.y + p.dy) - p.y, cancelled ? e.timeStamp + 1000 : e.timeStamp);
  };
  const pullFns = useRef({ pullMove, pullEnd });
  pullFns.current = { pullMove, pullEnd };
  const pulledAt = useRef(0);
  useEffect(() => {
    const el = section.current;
    if (!el) return;
    const onStart = (e: TouchEvent) => {
      const target = e.target as Node;
      const move = (ev: Event) => pullFns.current.pullMove(ev as TouchEvent);
      const done = (ev: TouchEvent) => {
        target.removeEventListener("touchmove", move);
        target.removeEventListener("touchend", end);
        target.removeEventListener("touchcancel", cancel);
        pullFns.current.pullEnd(ev, ev.type === "touchcancel");
      };
      const end = (ev: Event) => done(ev as TouchEvent);
      const cancel = end;
      target.addEventListener("touchmove", move, { passive: false });
      target.addEventListener("touchend", end);
      target.addEventListener("touchcancel", cancel);
    };
    // Runs after React's onTouchStart (which sets up `pull`): both listen on the way up.
    el.addEventListener("touchstart", onStart, { passive: true });
    return () => el.removeEventListener("touchstart", onStart);
  }, []);
  // Hold the month name: a joystick for months. Lean left or right, further = faster, a tick for each month.
  const [scrub, setScrub] = useState<number | null>(null);
  const scrubRef = useRef<{ timer: number; x0: number; x: number; on: boolean; at: number; acc: number; frame: number; m: number } | null>(null);
  const startScrub = (x: number) => {
    const s = { timer: 0, x0: x, x, on: false, at: 0, acc: 0, frame: 0, m: year * 12 + month - 1 };
    s.timer = window.setTimeout(() => {
      s.on = true;
      s.at = performance.now();
      haptic("press", 0.8);
      setScrub(s.m);
      const loop = (now: number) => {
        const off = s.x - s.x0;
        const dt = (now - s.at) / 1000;
        s.at = now;
        const lean = Math.abs(off) - 14;
        if (lean > 0) {
          // Gentle near the middle for one month at a time, up to ~16 months a second at full lean.
          const rate = Math.min(14, 0.8 + Math.pow(lean / 40, 1.8) * 1.6);
          if (s.acc === 0) s.acc = 1;
          else s.acc += rate * dt;
          while (s.acc >= 1) {
            s.acc -= 1;
            s.m += off > 0 ? 1 : -1;
            haptic("tick", Math.min(1, 0.35 + lean / 160));
            setScrub(s.m);
          }
          if (s.acc === 0) s.acc = 0.0001;
        } else s.acc = 0;
        s.frame = requestAnimationFrame(loop);
      };
      s.frame = requestAnimationFrame(loop);
    }, 360);
    scrubRef.current = s;
  };
  const stopScrub = () => {
    const s = scrubRef.current;
    scrubRef.current = null;
    if (!s) return false;
    window.clearTimeout(s.timer);
    cancelAnimationFrame(s.frame);
    if (!s.on) return false;
    setScrub(null);
    titleSwiped.current = Date.now();
    const target = s.m;
    if (target !== year * 12 + month - 1) {
      haptic("edge", 0.8);
      const y = Math.floor(target / 12);
      const m = target - y * 12;
      const last = new Date(y, m + 1, 0).getDate();
      onPick(dayKey(new Date(y, m, Math.min(Number(day.slice(8, 10)), last))));
    }
    return true;
  };
  const shownYear = scrub == null ? year : Math.floor(scrub / 12);
  const shownMonth = scrub == null ? month : scrub - shownYear * 12 + 1;
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
        className={`month-calendar${collapsed ? " collapsed" : ""}${compact ? " compact" : ""}${sheet ? " floating" : ""}${shading.search ? " search-mode" : ""}${scrub != null ? " scrubbing" : ""}${pulling ? " pulling" : ""}`}
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
          // The month itself doesn't scroll (only Coming up does, inside it): wheeling down on the month folds it.
          if (collapsed || e.deltaY <= 0 || (e.target as HTMLElement).closest?.(".reminders")) return void (wheelPast.current = 0);
          wheelPast.current += e.deltaY;
          if (wheelPast.current > 160) {
            wheelPast.current = 0;
            toggle(false);
          }
        }}
        onTouchStart={(e) => {
          const t = e.touches[0];
          drag.current = { y: t.clientY, x: t.clientX };
          pull.current = collapsed ? { x: t.clientX, y: t.clientY, t: e.timeStamp, base: section.current?.offsetHeight ?? 0, on: false, dy: 0 } : null;
        }}
        // The pull itself is followed by pullMove / pullEnd (see above).
        onTouchEnd={(e) => {
          const start = drag.current;
          drag.current = null;
          if (Date.now() - pulledAt.current < 200) return void e.stopPropagation();
          pull.current = null;
          if (!start) return;
          const dy = e.changedTouches[0].clientY - start.y;
          const dx = e.changedTouches[0].clientX - start.x;
          // A swipe left in the open month slides the year in: the page's own swipe does it (the year
          // follows the finger there and is let go cleanly), so nothing to do here.
          if (Math.abs(dx) > Math.abs(dy) * 1.5) return;
          if (Math.abs(dy) < 30 || Math.abs(dy) < Math.abs(dx) * 1.5) return;
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
            // Only in the month: on the week strip a sideways swipe is the strip's own (menu / year).
            onTouchStart={(e) => {
              startScrub(e.touches[0].clientX);
              if (collapsed) return;
              e.stopPropagation();
              titleTouch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
            }}
            onTouchMove={(e) => {
              const s = scrubRef.current;
              const t = e.touches[0];
              if (s) {
                s.x = t.clientX;
                // Moved before the hold counted: a swipe, not the joystick.
                if (!s.on && Math.abs(t.clientX - s.x0) > 10) stopScrub();
              }
              if (s?.on) {
                e.stopPropagation();
                pull.current = null;
                return;
              }
              if (!collapsed) e.stopPropagation();
            }}
            onTouchCancel={() => stopScrub()}
            onTouchEnd={(e) => {
              if (stopScrub()) {
                e.stopPropagation();
                titleTouch.current = null;
                drag.current = null;
                pull.current = null;
                return;
              }
              if (collapsed) return;
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
            {scrub != null && <span className="scrub-arrow" aria-hidden>◀</span>}
            {MONTH_NAMES[shownMonth - 1]} {shownYear} {scrub != null ? <span className="scrub-arrow" aria-hidden>▶</span> : collapsed ? "▾" : "▴"}
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
          year={shownYear}
          month={shownMonth - 1}
          counts={shading.counts}
          max={maxFor(shading, scrub == null ? day.slice(0, 7) : `${shownYear}-${String(shownMonth).padStart(2, "0")}`, today)}
          search={shading.search}
          selected={day}
          today={today}
          onPick={onPick}
          weekOnly={collapsed && scrub == null}
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
  // The twelve months are drawn once the phone is idle (and kept), so the year never slides in half drawn.
  const [warm, setWarm] = useState(open);
  useEffect(() => {
    if (open) return setWarm(true);
    const idle = window.requestIdleCallback ?? ((f: () => void) => window.setTimeout(f, 1500));
    const id = idle(() => setWarm(true));
    return () => (window.cancelIdleCallback ?? window.clearTimeout)(id as number);
  }, [open]);

  useEscapeToClose(onClose, !!open);

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
        {warm && <div className="year-grid">
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
