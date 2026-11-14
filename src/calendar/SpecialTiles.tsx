// Festive and special-date tiles in the month calendar: a quiet ambient animation on the tile
// (transform and opacity only, paused when the app rests), and press-and-hold (~300 ms) to lift the
// tile into a preview card over a blurred backdrop. Letting go springs it back; it never opens the day.
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { haptic } from "../lib/haptic";
import { useEditorPrefs } from "../lib/editorPrefs";
import { personalDates, specialsOn, subscribePersonalDates, type Special } from "../lib/specialDates";

const HOLD_MS = 300;
const MOVE_PX = 10;

/** Special days, following the "Special dates" page. */
export function useSpecials(): (day: string) => Special[] {
  const list = useSyncExternalStore(subscribePersonalDates, personalDates, personalDates);
  return (day: string) => specialsOn(day, list);
}

/** Whether tiles animate (Settings → Calendar). */
export const useFestiveTiles = () => useEditorPrefs().festiveTiles;

/** The little decorations inside a tile. */
export function TileFx({ s, animate }: { s: Special; animate: boolean }) {
  const pieces = s.kind === "birthday" ? 4 : s.kind === "diwali" || s.kind === "newyear" ? 3 : 0;
  return (
    <>
      {animate && pieces > 0 && (
        <span className="fest-fx" aria-hidden>
          {Array.from({ length: pieces }, (_, i) => <i key={i} />)}
        </span>
      )}
      <span className="fest-badge" aria-hidden>{s.emoji}</span>
    </>
  );
}

interface Held {
  day: string;
  specials: Special[];
  from: DOMRect;
}

/**
 * Press-and-hold for special tiles. Returns the handlers to put on a tile, whether the last press
 * was a hold (so the click that follows is ignored), and the preview to render.
 */
export function useHoldPreview(): {
  bind: (day: string, specials: Special[]) => Record<string, unknown>;
  wasHold: () => boolean;
  preview: ReactNode;
} {
  const timer = useRef(0);
  const start = useRef<{ x: number; y: number } | null>(null);
  const held = useRef(false);
  const [open, setOpen] = useState<Held | null>(null);
  const [closing, setClosing] = useState(false);

  const cancel = () => {
    window.clearTimeout(timer.current);
    timer.current = 0;
    start.current = null;
  };
  const close = () => {
    cancel();
    setClosing(true);
  };

  // While the card is up: letting go anywhere closes it, and the page doesn't scroll under it.
  useEffect(() => {
    if (!open) return;
    const up = () => close();
    const stop = (e: TouchEvent) => e.cancelable && e.preventDefault();
    const key = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    window.addEventListener("touchend", up);
    window.addEventListener("touchmove", stop, { passive: false });
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      window.removeEventListener("touchend", up);
      window.removeEventListener("touchmove", stop);
      window.removeEventListener("keydown", key);
    };
  }, [open]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const bind = (day: string, specials: Special[]) =>
    specials.length
      ? {
          onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
            if (e.button !== 0) return;
            held.current = false;
            start.current = { x: e.clientX, y: e.clientY };
            const el = e.currentTarget;
            window.clearTimeout(timer.current);
            timer.current = window.setTimeout(() => {
              timer.current = 0;
              held.current = true;
              haptic("press", 0.7);
              setClosing(false);
              setOpen({ day, specials, from: el.getBoundingClientRect() });
            }, HOLD_MS);
          },
          onPointerMove: (e: React.PointerEvent) => {
            const s = start.current;
            if (s && timer.current && Math.hypot(e.clientX - s.x, e.clientY - s.y) > MOVE_PX) cancel();
          },
          onPointerUp: () => timer.current && cancel(),
          onPointerLeave: () => timer.current && cancel(),
          onPointerCancel: () => timer.current && cancel(),
          // Android's long-press menu and text selection.
          onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
        }
      : {};

  const wasHold = () => {
    const h = held.current;
    held.current = false;
    return h;
  };

  const preview = open
    ? createPortal(<HoldCard held={open} closing={closing} onClosed={() => (setOpen(null), setClosing(false))} />, document.body)
    : null;
  return { bind, wasHold, preview };
}

const MONTH_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAY_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function whenText(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const t = new Date(y, m - 1, d).getTime();
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const n = Math.round((t - today) / 86_400_000);
  if (n === 0) return "Today";
  if (n === 1) return "Tomorrow";
  if (n === -1) return "Yesterday";
  return n > 0 ? `In ${n} days` : `${-n} days ago`;
}

/** The lifted card: grows out of the tile, with the full themed animation; shrinks back into it. */
function HoldCard({ held, closing, onClosed }: { held: Held; closing: boolean; onClosed: () => void }) {
  const card = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);
  const main = held.specials[0];
  const [y, m, d] = held.day.split("-").map(Number);
  const date = new Date(y, m - 1, d);

  // From the tile's place and size (no transition), then to the centre on the next frame.
  const fromTile = () => {
    const el = card.current;
    if (!el) return "";
    const r = el.getBoundingClientRect();
    const f = held.from;
    const s = Math.max(0.05, f.width / r.width);
    return `translate(${f.left + f.width / 2 - (r.left + r.width / 2)}px, ${f.top + f.height / 2 - (r.top + r.height / 2)}px) scale(${s})`;
  };
  useEffect(() => {
    const el = card.current;
    if (!el) return;
    el.style.transition = "none";
    el.style.transform = fromTile();
    el.style.opacity = "0.4";
    const f = requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        el.style.transition = "";
        el.style.transform = "";
        el.style.opacity = "";
        setShown(true);
      }),
    );
    return () => cancelAnimationFrame(f);
    // Once, on lifting.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!closing) return;
    const el = card.current;
    if (el) {
      el.classList.add("closing");
      el.style.transform = fromTile();
      el.style.opacity = "0";
    }
    const t = window.setTimeout(onClosed, 240);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closing]);

  return (
    <div className={`fest-hold${shown && !closing ? " shown" : ""}`} role="dialog" aria-label={main.title}>
      <div className="fest-hold-backdrop" />
      <div ref={card} className={`fest-card fest-${main.kind}`}>
        <div className="fest-card-scene" aria-hidden>
          {Array.from({ length: 12 }, (_, i) => <i key={i} style={{ ["--i" as string]: i, ["--y" as string]: `${((i * 37) % 70) + 8}%` }} />)}
          <span className="fest-card-emoji">{main.emoji}</span>
        </div>
        <div className="fest-card-body">
          <h2>{main.title}</h2>
          <p className="fest-card-date">
            {WEEKDAY_LONG[date.getDay()]}, {d} {MONTH_LONG[m - 1]} {y} · {whenText(held.day)}
          </p>
          <p className="fest-card-greeting">{main.greeting}</p>
          {held.specials.slice(1).map((s, i) => (
            <p key={i} className="fest-card-more">{s.emoji} {s.title}</p>
          ))}
        </div>
      </div>
    </div>
  );
}
