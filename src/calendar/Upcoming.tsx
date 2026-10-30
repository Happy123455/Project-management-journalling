import React, { useEffect, useRef, useState } from "react";
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

/** Saturdays and Sundays from tomorrow up to and including `to`. */
export function weekendsUntil(from: string, to: string): { saturdays: number; sundays: number } {
  let saturdays = 0;
  let sundays = 0;
  const end = Date.parse(`${to}T12:00:00`);
  for (let t = Date.parse(`${from}T12:00:00`) + 86_400_000; t <= end; t += 86_400_000) {
    const wd = new Date(t).getDay();
    if (wd === 6) saturdays++;
    else if (wd === 0) sundays++;
  }
  return { saturdays, sundays };
}

/**
 * "N days left" and a dash per day (at most 30, then "+N"), warmer as the day gets close.
 * Weekends stand out: a Saturday–Sunday pair sits in one oval, and the free days are counted.
 */
function Countdown({ day }: { day: string }) {
  const today = dayKey(new Date());
  const left = daysBetween(today, day);
  const shown = Math.min(left, BAR_MAX);
  // 0 = due now (red), 1 = a month or more away (cool blue).
  const far = Math.min(1, left / BAR_MAX);
  const hue = Math.round(far * 210);
  const { saturdays, sundays } = weekendsUntil(today, day);
  const marks: React.ReactNode[] = [];
  for (let i = 1; i <= shown; i++) {
    const wd = new Date(Date.parse(`${today}T12:00:00`) + i * 86_400_000).getDay();
    if (wd === 6 && i < shown) {
      marks.push(<span key={i} className="cd-weekend" title="Saturday + Sunday"><i /><i /></span>);
      i++;
    } else if (wd === 6 || wd === 0) marks.push(<span key={i} className="cd-weekend single"><i /></span>);
    else marks.push(<i key={i} className="cd-day" />);
  }
  return (
    <span className="countdown" style={{ "--countdown-hue": hue } as React.CSSProperties}>
      <span className="countdown-days">{left === 1 ? "1 day left" : `${left} days left`}</span>
      <span className="countdown-bar" aria-hidden>
        {marks}
        {left > BAR_MAX && <span className="countdown-more">+{left - BAR_MAX}</span>}
      </span>
      {saturdays + sundays > 0 && (
        <span className="countdown-weekends" title={`${saturdays} Saturdays and ${sundays} Sundays before the day`}>
          {saturdays} Sat · {sundays} Sun
        </span>
      )}
    </span>
  );
}

/**
 * Reminders still ahead, soonest first. Scrolling the list squeezes the ones that went past the
 * top into thin rows stacked there, so they stay in sight.
 */
export function Upcoming({ pages, onPick, title = "Coming up" }: { pages: DayPage[]; onPick: (day: string) => void; title?: string }) {
  const list = useRef<HTMLUListElement>(null);
  const [squeezed, setSqueezed] = useState(0);
  useEffect(() => {
    const ul = list.current;
    const scroller = ul?.closest<HTMLElement>(".upcoming-scroll, .month-calendar");
    if (!ul || !scroller) return;
    let frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const top = scroller.getBoundingClientRect().top;
        let n = 0;
        for (const li of ul.children) {
          if ((li as HTMLElement).getBoundingClientRect().top - top < 14 + n * 26) n++;
          else break;
        }
        setSqueezed(Math.min(n, STACK_MAX));
      });
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      scroller.removeEventListener("scroll", onScroll);
    };
  }, [pages.length]);
  if (!pages.length) return null;
  return (
    <section className="reminders upcoming">
      <h2>{title}</h2>
      <ul ref={list}>
        {pages.map((p, i) => (
          <li key={p.day} className={i < squeezed ? "squeezed" : ""} style={i < STACK_MAX ? ({ "--stack": i } as React.CSSProperties) : undefined}>
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

const STACK_MAX = 5;

/** Everything coming up, as its own panel (swipe left past the year view). */
export function UpcomingPanel({ open, pages, onPick, onClose }: { open: boolean; pages: DayPage[]; onPick: (day: string) => void; onClose: () => void }) {
  const touch = useRef<{ x: number; y: number } | null>(null);
  return (
    <aside
      className={`upcoming-panel${open ? " open" : ""}`}
      aria-hidden={!open}
      onTouchStart={(e) => (touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY })}
      onTouchEnd={(e) => {
        const start = touch.current;
        touch.current = null;
        if (!start) return;
        const dx = e.changedTouches[0].clientX - start.x;
        if (dx > 70 && Math.abs(dx) > Math.abs(e.changedTouches[0].clientY - start.y) * 1.5) onClose();
      }}
    >
      <header className="year-header">
        <button type="button" onClick={onClose} aria-label="Back to the year">‹</button>
        <h2>Coming up</h2>
        <span />
        <button type="button" className="close" onClick={onClose} aria-label="Close">✕</button>
      </header>
      <div className="upcoming-scroll">
        {open && (pages.length ? <Upcoming pages={pages} onPick={onPick} title={`${pages.length} ahead`} /> : <p className="hint">Nothing coming up. Write on a future day to set a reminder.</p>)}
      </div>
    </aside>
  );
}
