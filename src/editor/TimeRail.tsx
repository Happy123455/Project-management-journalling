import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/react";
import type { Node as PMNode } from "@tiptap/pm/model";
import { formatGap, railPlaces, stampsIn, type Stamp } from "../lib/timeGaps";
import { skyAt } from "../lib/sky";

/**
 * Time rail: Outline → 🕒 Time puts a thin line on the right edge of the note, like a scroll bar,
 * but laid out by the clock: each timestamp is a dot at its real time between the first and the
 * last one, so the gaps between dots are the real time that passed. Touch or drag it to go to a
 * timestamp; the dot of the part being read is lit.
 */

const KEY = "journal.timeRail";
const EVENT = "journal:time-rail";

export function timeRailOn(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function setTimeRail(on: boolean) {
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    // For this session only.
  }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: on }));
}

export function useTimeRail(): boolean {
  const [on, setOn] = useState(timeRailOn);
  useEffect(() => {
    const f = (e: Event) => setOn(!!(e as CustomEvent<boolean>).detail);
    window.addEventListener(EVENT, f);
    return () => window.removeEventListener(EVENT, f);
  }, []);
  return on;
}

/** Every timestamp in the note, in writing order. */
export function noteStamps(doc: PMNode): Stamp[] {
  const lines: { pos: number; text: string }[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    if (node.type.name !== "codeBlock") lines.push({ pos: pos + 1, text: node.textBetween(0, node.content.size, undefined, "￼") });
    return false;
  });
  return stampsIn(lines);
}

const clock = (t: number) => {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/** Keeps the note's timestamps current while the rail or the Time outline is showing. */
export function useStamps(editor: Editor, on: boolean): Stamp[] {
  const [stamps, setStamps] = useState<Stamp[]>(() => (on ? noteStamps(editor.state.doc) : []));
  useEffect(() => {
    if (!on) return;
    setStamps(noteStamps(editor.state.doc));
    let timer: number | undefined;
    // Typing doesn't move the rail on every letter; it catches up a moment later.
    const update = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setStamps(noteStamps(editor.state.doc)), 400);
    };
    editor.on("update", update);
    return () => {
      window.clearTimeout(timer);
      editor.off("update", update);
    };
  }, [editor, on]);
  return stamps;
}

export function TimeRail({ editor, onJump }: { editor: Editor; onJump: (pos: number) => void }) {
  const stamps = useStamps(editor, true);
  const [active, setActive] = useState(-1);
  const [touching, setTouching] = useState(false);
  const rail = useRef<HTMLDivElement>(null);
  const lastJump = useRef(-1);

  // In time order, with each one's place on the rail (0 = earliest, 1 = latest).
  const sorted = useMemo(() => {
    const places = railPlaces(stamps);
    return stamps.map((s, i) => ({ ...s, i, at: places[i] })).sort((a, b) => a.time - b.time || a.pos - b.pos);
  }, [stamps]);

  // The note keeps clear of the rail (its buttons on the right edge stay tappable).
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("time-rail-on");
    return () => root.classList.remove("time-rail-on");
  }, []);

  // The part being read: the last timestamp above a line 30% down the screen.
  useEffect(() => {
    if (!stamps.length) return;
    let frame = 0;
    const find = () => {
      frame = 0;
      const box = editor.view.dom.getBoundingClientRect();
      const hit = editor.view.posAtCoords({ left: box.left + Math.min(40, box.width / 2), top: Math.max(box.top + 1, window.innerHeight * 0.3) });
      if (!hit) return;
      let a = -1;
      for (let i = 0; i < stamps.length && stamps[i].pos <= hit.pos; i++) a = i;
      setActive(a < 0 ? 0 : a);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(find);
    };
    find();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
    };
  }, [editor, stamps]);

  if (stamps.length < 2) return null;
  const first = sorted[0].time;
  const last = sorted[sorted.length - 1].time;

  // Touching or dragging along the rail goes to the timestamp nearest that time.
  const go = (clientY: number) => {
    const r = rail.current?.getBoundingClientRect();
    if (!r) return;
    const f = Math.min(1, Math.max(0, (clientY - r.top) / r.height));
    let best = sorted[0];
    for (const s of sorted) if (Math.abs(s.at - f) < Math.abs(best.at - f)) best = s;
    if (best.pos === lastJump.current) return;
    lastJump.current = best.pos;
    onJump(best.pos);
  };

  return createPortal(
    <div
      className={touching ? "time-rail touching" : "time-rail"}
      ref={rail}
      aria-label={`Timeline: ${formatGap(last - first)} from the first to the last timestamp`}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture?.(e.pointerId);
        setTouching(true);
        lastJump.current = -1;
        go(e.clientY);
      }}
      onPointerMove={(e) => touching && go(e.clientY)}
      onPointerUp={() => setTouching(false)}
      onPointerCancel={() => setTouching(false)}
    >
      <span className="time-rail-end top">{clock(first)}</span>
      {sorted.slice(1).map((s, k) => {
        const prev = sorted[k];
        const h = (s.at - prev.at) * 100;
        if (h <= 0) return null;
        return (
          <span
            key={`seg-${prev.pos}-${s.pos}`}
            className="time-rail-seg"
            style={{ top: `${prev.at * 100}%`, height: `${h}%`, background: `linear-gradient(${skyAt(prev.time).bg}, ${skyAt(s.time).bg})` }}
          >
            {h >= 7 && <em>{formatGap(s.time - prev.time)}</em>}
          </span>
        );
      })}
      {sorted.map((s) => (
        <button
          type="button"
          key={`dot-${s.pos}`}
          className={s.i === active ? "time-rail-dot active" : "time-rail-dot"}
          style={{ top: `${s.at * 100}%`, background: skyAt(s.time).bg }}
          title={`${clock(s.time)} ${s.label}`}
          aria-label={`${clock(s.time)} ${s.label}`}
          // Touch and mouse already went there on press; this is for the keyboard.
          onClick={(e) => e.detail === 0 && onJump(s.pos)}
        >
          {s.i === active && <i>{clock(s.time)}</i>}
        </button>
      ))}
      <span className="time-rail-end bottom">{clock(last)}</span>
    </div>,
    document.body,
  );
}
