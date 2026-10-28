import { useEffect, useRef, useState } from "react";

const THRESHOLD_PX = 110;

const atBottom = () => window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4;
const typing = () => !!document.activeElement?.closest?.(".tiptap");

/**
 * Pulling up past the end of the page (phone) shows "↑ Today" filling up; letting go past the
 * threshold opens today's note. Not while typing, and not when already on today.
 */
export function PullToToday({ enabled, onToday }: { enabled: boolean; onToday: () => void }) {
  const [pull, setPull] = useState(0);
  const start = useRef<number | null>(null);
  const go = useRef(onToday);
  go.current = onToday;

  useEffect(() => {
    if (!enabled) return;
    let pulled = 0;
    const onStart = (e: TouchEvent) => {
      start.current = atBottom() && !typing() && e.touches.length === 1 ? e.touches[0].clientY : null;
      pulled = 0;
    };
    const onMove = (e: TouchEvent) => {
      if (start.current === null) return;
      pulled = Math.max(0, start.current - e.touches[0].clientY);
      setPull(pulled);
    };
    const onEnd = () => {
      if (start.current !== null && pulled >= THRESHOLD_PX) go.current();
      start.current = null;
      setPull(0);
    };
    window.addEventListener("touchstart", onStart, { passive: true });
    window.addEventListener("touchmove", onMove, { passive: true });
    window.addEventListener("touchend", onEnd);
    window.addEventListener("touchcancel", onEnd);
    return () => {
      window.removeEventListener("touchstart", onStart);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onEnd);
      window.removeEventListener("touchcancel", onEnd);
    };
  }, [enabled]);

  if (!enabled || pull < 12) return null;
  const progress = Math.min(1, pull / THRESHOLD_PX);
  return (
    <div className={progress >= 1 ? "pull-today ready" : "pull-today"} style={{ transform: `translate(-50%, ${-Math.min(pull, THRESHOLD_PX) * 0.4}px)` }}>
      <span className="pull-today-fill" style={{ width: `${progress * 100}%` }} />
      <span className="pull-today-text">{progress >= 1 ? "Release for today" : "↑ Pull for today"}</span>
    </div>
  );
}
