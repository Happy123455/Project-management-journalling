// Item 14 (16 Nov): the deadline editor's day pickers as a small month grid, like the month
// calendar, instead of dropdowns. It shows today, the deadline's days from start to the 🏁 due
// day, days that already have plans (a dot), weekends and festivals; tapping a day picks it.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { dayLabel } from "../lib/deadline";
import { festivalsOn } from "../lib/specialDates";
import { editorPrefs, shownFestGroups } from "../lib/editorPrefs";
import { dayKey } from "../lib/timestamp";
import { fx } from "../lib/fx";

const WD = ["S", "M", "T", "W", "T", "F", "S"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export interface DayMarks {
  /** The deadline's first and 🏁 due day: the days between are tinted. */
  from?: string;
  due?: string;
  /** Days that already have plans. */
  planned?: Set<string>;
  /** Only these days can be picked (others are greyed); none = any day from `min`. */
  allowed?: Set<string>;
  /** No day before this one. */
  min?: string;
}

/** The weeks of a month as rows of day keys (null = padding). */
export function monthCells(year: number, month: number): (string | null)[] {
  const first = new Date(year, month, 1).getDay();
  const length = new Date(year, month + 1, 0).getDate();
  const cells: (string | null)[] = Array(first).fill(null);
  for (let d = 1; d <= length; d++) cells.push(dayKey(new Date(year, month, d)));
  while (cells.length % 7) cells.push(null);
  return cells;
}

/** Whether a day can be picked. */
export const canPick = (day: string, m: DayMarks) => (m.allowed ? m.allowed.has(day) : true) && (!m.min || day >= m.min);

/** The month grid itself. */
export function DayGrid({ value, onPick, marks }: { value: string; onPick: (day: string) => void; marks: DayMarks }) {
  const [shown, setShown] = useState(() => ({ y: Number(value.slice(0, 4)), m: Number(value.slice(5, 7)) - 1 }));
  const today = dayKey(new Date());
  const groups = shownFestGroups(editorPrefs());
  const step = (by: number) => {
    fx("tick");
    setShown(({ y, m }) => ({ y: y + Math.floor((m + by) / 12), m: (((m + by) % 12) + 12) % 12 }));
  };
  return (
    <div className="dgp">
      <div className="dgp-bar">
        <button type="button" onClick={() => step(-1)} aria-label="Previous month">‹</button>
        <b>{MONTHS[shown.m]} {shown.y}</b>
        <button type="button" onClick={() => step(1)} aria-label="Next month">›</button>
      </div>
      <div className="dgp-grid">
        {WD.map((w, i) => <span key={i} className="dgp-wd">{w}</span>)}
        {monthCells(shown.y, shown.m).map((d, i) => {
          if (!d) return <span key={i} />;
          const wd = new Date(`${d}T12:00:00`).getDay();
          const fest = festivalsOn(d, groups)[0];
          const ok = canPick(d, marks);
          const inRange = !!marks.from && !!marks.due && d >= marks.from && d <= marks.due;
          const cls = [
            "dgp-day",
            d === value && "sel",
            d === today && "today",
            inRange && "range",
            d === marks.due && "due",
            (wd === 0 || wd === 6) && "weekend",
            !ok && "off",
          ].filter(Boolean).join(" ");
          return (
            <button key={d} type="button" className={cls} disabled={!ok} title={`${dayLabel(d).text}${fest ? ` · ${fest.title}` : ""}${d === marks.due ? " · 🏁 due" : ""}${marks.planned?.has(d) ? " · has plans" : ""}`} onClick={() => (fx("drop"), onPick(d))}>
              {Number(d.slice(8))}
              {d === marks.due && <i className="dgp-flag" aria-hidden>🏁</i>}
              {fest && d !== marks.due && <i className="dgp-fest" aria-hidden>{fest.emoji}</i>}
              {marks.planned?.has(d) && <i className="dgp-dot" aria-hidden />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** A popover under (or above) an anchor, kept inside the window; closes on a tap outside or Escape. */
export function Popover({ anchor, onClose, children }: { anchor: HTMLElement | null; onClose: () => void; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const a = anchor?.getBoundingClientRect();
    const el = box.current;
    if (!a || !el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const left = Math.max(8, Math.min(window.innerWidth - w - 8, a.left + a.width / 2 - w / 2));
    const below = a.bottom + 6;
    const top = below + h > window.innerHeight - 8 && a.top - h - 6 > 8 ? a.top - h - 6 : Math.min(below, window.innerHeight - h - 8);
    setPos({ left, top: Math.max(8, top) });
  }, [anchor]);
  useEffect(() => {
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (box.current?.contains(t) || anchor?.contains(t)) return;
      onClose();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && (e.stopPropagation(), onClose());
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key, true);
    };
  }, [anchor, onClose]);
  return createPortal(
    <div
      ref={box}
      className="dgp-pop"
      style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: "hidden" }}
      // Inside a note: taps here are for the picker, never the editor under it.
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </div>,
    document.body,
  );
}

/** A button with the picked day ("Tue 18 Nov ▾") that opens the month grid. */
export function DayPickerButton({ value, onPick, marks, className, label }: { value: string; onPick: (day: string) => void; marks: DayMarks; className?: string; label?: string }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={btn} type="button" className={`dgp-btn${className ? ` ${className}` : ""}`} aria-expanded={open} onClick={() => (fx(open ? "close" : "open"), setOpen(!open))}>
        {label ?? dayLabel(value).text} <span aria-hidden>▾</span>
      </button>
      {open && (
        <Popover anchor={btn.current} onClose={() => setOpen(false)}>
          <DayGrid
            value={value}
            marks={marks}
            onPick={(d) => {
              onPick(d);
              setOpen(false);
            }}
          />
        </Popover>
      )}
    </>
  );
}
