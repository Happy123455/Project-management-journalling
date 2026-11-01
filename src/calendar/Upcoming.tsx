import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { addDays, dayKey, dayTitle } from "../lib/timestamp";
import { REPEATS, stepDay, type Repeat } from "../lib/reminders";
import { docText } from "../lib/words";
import { MediaPeek, mediaItemsIn, type PeekItem } from "../editor/MediaPeek";
import { Marquee } from "../ui/Marquee";
import type { JSONContent } from "@tiptap/react";
import type { DayPage } from "../store";

/** First line of a page, cut short for a one-line preview. */
function snippet(page: DayPage): string {
  const line = docText(page.content).split("\n").find((l) => l.trim()) ?? "";
  return line.length > 80 ? line.slice(0, 79) + "…" : line;
}

/** A piece of the first line: text, or a GIF/photo/clip placed in it. */
export type LinePart = { text: string } | { media: PeekItem };

/**
 * The first line with something in it, in order: words and the media placed between them, so the
 * folded Coming up row shows a GIF where it sits in the note, not at the end of the row.
 */
export function firstLineParts(doc: JSONContent | null | undefined, maxChars = 200): LinePart[] {
  for (const block of doc?.content ?? []) {
    const parts: LinePart[] = [];
    let chars = 0;
    let done = false;
    const walk = (n: JSONContent) => {
      if (done) return;
      const a = n.attrs ?? {};
      if (n.type === "text" && n.text) {
        const last = parts[parts.length - 1];
        if (last && "text" in last) last.text += n.text;
        else parts.push({ text: n.text });
        chars += n.text.length;
      } else if (n.type === "hardBreak") parts.push({ text: " " });
      else if (n.type === "attachmentImage" && a.fileId) parts.push({ media: { kind: "image", fileId: a.fileId, name: a.name ?? "" } });
      else if (n.type === "attachmentMedia" && a.fileId) parts.push({ media: { kind: a.kind === "audio" ? "audio" : "video", fileId: a.fileId, name: a.name ?? "" } });
      else n.content?.forEach(walk);
      // One line: stop after the first paragraph (or heading, or list item's text) that had something.
      if ((n.type === "paragraph" || n.type === "heading") && parts.length) done = true;
      if (chars >= maxChars) done = true;
    };
    walk(block);
    const kept = parts.filter((p) => !("text" in p) || p.text.trim());
    if (kept.length) return kept;
  }
  return [];
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
            <MediaPeek items={mediaItemsIn(p.content)} />
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
      <span className="cd-left">{left}</span>
      {saturdays + sundays > 0 && (
        <span className="countdown-weekends" title={`${saturdays} Saturdays and ${sundays} Sundays before the day`}>
          {saturdays} Sat · {sundays} Sun
        </span>
      )}
    </span>
  );
}

/** "3 Nov": the day in the thin, folded rows. */
const shortDay = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" });

/** One reminder. Memoised: scrolling only re-renders the rows whose squeeze changed. */
/** What can be done to a reminder from its row: move it to another day, or make it repeat. */
export type ReminderAction = { kind: "snooze"; to: string } | { kind: "pick" } | { kind: "repeat"; repeat: Repeat | null };
/** A Coming up row; a repeating reminder's row stands for its next day (`repeatOf`: the day it was written on). */
export type UpcomingPage = DayPage & { repeatOf?: string };

function RowMenu({ page, onAction, onClose }: { page: UpcomingPage; onAction: (page: UpcomingPage, a: ReminderAction) => void; onClose: () => void }) {
  const today = dayKey(new Date());
  const from = page.day > today ? page.day : today;
  const act = (a: ReminderAction) => {
    onClose();
    onAction(page, a);
  };
  const current = page.props.repeat ?? null;
  return (
    <div className="reminder-menu" role="menu" onClick={(e) => e.stopPropagation()}>
      {!page.repeatOf && (
        <div className="reminder-menu-row">
          <span>⏰ Move to</span>
          <button type="button" onClick={() => act({ kind: "snooze", to: addDays(from, 1) })}>+1 day</button>
          <button type="button" onClick={() => act({ kind: "snooze", to: addDays(from, 7) })}>+1 week</button>
          <button type="button" onClick={() => act({ kind: "snooze", to: stepDay(from, "monthly") })}>+1 month</button>
          <button type="button" onClick={() => act({ kind: "pick" })}>📅 Pick…</button>
        </div>
      )}
      <div className="reminder-menu-row">
        <span>🔁 Repeat</span>
        <button type="button" className={!current ? "active" : ""} onClick={() => act({ kind: "repeat", repeat: null })}>Off</button>
        {REPEATS.map((r) => (
          <button key={r.value} type="button" className={current === r.value ? "active" : ""} onClick={() => act({ kind: "repeat", repeat: r.value })}>
            {r.label.replace("Every ", "")}
          </button>
        ))}
      </div>
    </div>
  );
}

const UpcomingRow = React.memo(function UpcomingRow({ page, squeezed, stack, folded, onPick, onAction }: { page: UpcomingPage; squeezed: boolean; stack: number | null; folded: boolean; onPick: (day: string) => void; onAction?: (page: UpcomingPage, a: ReminderAction) => void }) {
  const [menu, setMenu] = useState(false);
  const parts = useMemo(() => firstLineParts(page.content, folded ? 200 : 120), [page.content, folded]);
  // Media in the line shows where it sits in the text; the rest of the note's media follows.
  const media = useMemo(() => {
    const inline = new Set(parts.flatMap((p) => ("media" in p && "fileId" in p.media ? [p.media.fileId] : [])));
    return mediaItemsIn(page.content).filter((m) => !("fileId" in m) || !inline.has(m.fileId));
  }, [page.content, parts]);
  const line = parts.map((p, i) =>
    "text" in p ? <span key={i}>{p.text}</span> : <span key={i} className="inline-peek"><MediaPeek items={[p.media]} /></span>,
  );
  return (
    <li className={squeezed ? "squeezed" : ""} style={stack !== null ? ({ "--stack": stack } as React.CSSProperties) : undefined}>
      <button type="button" className="reminder-open" onClick={() => onPick(page.repeatOf ?? page.day)}>
        <span className="reminder-day">{dayTitle(page.day)}{page.props.repeat && <span className="reminder-repeat" title={REPEATS.find((r) => r.value === page.props.repeat)?.label}> 🔁</span>}</span>
        <span className="reminder-short">{shortDay(page.day)}</span>
        {folded ? (
          <span className="reminder-text reminder-line">
            <Marquee>{line}</Marquee>
          </span>
        ) : (
          <span className="reminder-text reminder-inline">{line}</span>
        )}
        <Countdown day={page.day} />
      </button>
      {!folded && onAction && (
        <button type="button" className="reminder-more" aria-label="Move or repeat" aria-expanded={menu} onClick={() => setMenu(!menu)}>⋯</button>
      )}
      {menu && onAction && <RowMenu page={page} onAction={onAction} onClose={() => setMenu(false)} />}
      {!folded && media.length > 0 && <MediaPeek items={media} />}
    </li>
  );
});

/**
 * Reminders still ahead, soonest first. Scrolling the list squeezes the ones that went past the
 * top into thin rows stacked there, so they stay in sight. In the month, scrolling folds the whole
 * list into a thin table: day, text and days left on one line each.
 */
export function Upcoming({ pages, onPick, onAction, title = "Coming up", inMonth = false }: { pages: UpcomingPage[]; onPick: (day: string) => void; onAction?: (page: UpcomingPage, a: ReminderAction) => void; title?: string; inMonth?: boolean }) {
  const list = useRef<HTMLUListElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [squeezed, setSqueezed] = useState(0);
  const [folded, setFolded] = useState(false);
  // The app hands a new callback on every render; the rows keep one that never changes.
  const pick = useRef(onPick);
  pick.current = onPick;
  const stablePick = useCallback((day: string) => pick.current(day), []);
  // The Coming up panel: rows that went past the top squeeze into thin rows stacked there.
  useEffect(() => {
    const ul = list.current;
    const scroller = ul?.closest<HTMLElement>(".upcoming-scroll");
    if (inMonth || !ul || !scroller) return;
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
  }, [pages.length, inMonth]);

  // In the month: the month stays where it is. A swipe up inside Coming up folds only Coming up
  // (it then ends right under its last row, and scrolls by itself when the rows don't fit); a swipe
  // down at its top unfolds it. The month folds to its week only from a swipe on the month itself.
  const touch = useRef<number | null>(null);
  const wheel = useRef(0);
  const swipe = (dy: number) => {
    const el = box.current;
    if (dy < 0 && !folded) setFolded(true);
    else if (dy > 0 && folded && (!el || el.scrollTop <= 0)) setFolded(false);
  };
  if (!pages.length) return null;
  const rows = (
    <ul ref={list}>
      {pages.map((p, i) => (
        <UpcomingRow key={`${p.day}-${p.repeatOf ?? ""}`} page={p} onAction={onAction} folded={folded} squeezed={!inMonth && !folded && i < squeezed} stack={!inMonth && !folded && i < STACK_MAX ? i : null} onPick={stablePick} />
      ))}
    </ul>
  );
  if (!inMonth)
    return (
      <section className="reminders upcoming">
        <h2>{title}</h2>
        {rows}
      </section>
    );
  return (
    <section className={folded ? "reminders upcoming in-month folded" : "reminders upcoming in-month"}>
      <h2>
        <button type="button" className="upcoming-fold" onClick={() => setFolded(!folded)} aria-expanded={!folded}>
          {title} <span aria-hidden>{folded ? "▾" : "▴"}</span>
        </button>
      </h2>
      <div
        ref={box}
        className="upcoming-box"
        onTouchStart={(e) => {
          e.stopPropagation();
          touch.current = e.touches[0].clientY;
        }}
        onTouchEnd={(e) => {
          e.stopPropagation();
          const start = touch.current;
          touch.current = null;
          if (start === null) return;
          const dy = e.changedTouches[0].clientY - start;
          if (Math.abs(dy) >= 24) swipe(dy);
        }}
        onWheel={(e) => {
          e.stopPropagation();
          const el = box.current;
          if (e.deltaY > 0 && !folded) {
            wheel.current += e.deltaY;
            if (wheel.current > 60) (wheel.current = 0), setFolded(true);
          } else if (e.deltaY < 0 && folded && (!el || el.scrollTop <= 0)) {
            wheel.current -= e.deltaY;
            if (wheel.current > 60) (wheel.current = 0), setFolded(false);
          } else wheel.current = 0;
        }}
      >
        {rows}
      </div>
    </section>
  );
}

const STACK_MAX = 5;

/** Everything coming up, as its own panel (swipe left past the year view). */
export function UpcomingPanel({ open, pages, onPick, onAction, onClose }: { open: boolean; pages: UpcomingPage[]; onPick: (day: string) => void; onAction?: (page: UpcomingPage, a: ReminderAction) => void; onClose: () => void }) {
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
        {open && (pages.length ? <Upcoming pages={pages} onPick={onPick} onAction={onAction} title={`${pages.length} ahead`} /> : <p className="hint">Nothing coming up. Write on a future day to set a reminder.</p>)}
      </div>
    </aside>
  );
}
