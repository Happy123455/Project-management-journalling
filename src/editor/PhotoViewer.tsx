import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent } from "react";
import { clampPan, toggleZoom, zoomAt, type View } from "../lib/zoom";

const DOUBLE_TAP_MS = 300;
const DISMISS_DRAG_PX = 120;

type Point = { x: number; y: number };

/** Full-screen photo: pinch or wheel to zoom, drag to pan, double-tap to zoom, swipe down or ✕ to close. */
export function PhotoViewer({ url, onClose }: { url: string; onClose: () => void }) {
  const stage = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ scale: 1, x: 0, y: 0 });
  const [dismiss, setDismiss] = useState(0); // downward drag while not zoomed
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<{ view: View; dist: number; mid: Point; start: Point } | null>(null);
  const lastTap = useRef(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  /** A screen point relative to the centre of the stage. */
  const local = (p: Point): Point => {
    const r = stage.current!.getBoundingClientRect();
    return { x: p.x - (r.left + r.width / 2), y: p.y - (r.top + r.height / 2) };
  };
  const box = () => stage.current!.getBoundingClientRect();

  const begin = () => {
    const pts = [...pointers.current.values()];
    const [a, b] = pts;
    gesture.current = {
      view,
      dist: b ? Math.hypot(a.x - b.x, a.y - b.y) : 0,
      mid: b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : a,
      start: a,
    };
  };

  const onDown = (e: ReactPointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    begin();
  };

  const onMove = (e: ReactPointerEvent) => {
    if (!pointers.current.has(e.pointerId) || !gesture.current) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pts = [...pointers.current.values()];
    const g = gesture.current;
    if (pts.length >= 2) {
      // Pinch: scale by the change in finger distance around their midpoint, and follow the midpoint.
      const [a, b] = pts;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const zoomed = zoomAt(g.view, (g.view.scale * Math.hypot(a.x - b.x, a.y - b.y)) / g.dist, local(g.mid));
      setView(clampPan({ ...zoomed, x: zoomed.x + mid.x - g.mid.x, y: zoomed.y + mid.y - g.mid.y }, box()));
    } else if (g.view.scale > 1) {
      setView(clampPan({ ...g.view, x: g.view.x + e.clientX - g.start.x, y: g.view.y + e.clientY - g.start.y }, box()));
    } else {
      setDismiss(Math.max(0, e.clientY - g.start.y));
    }
  };

  const onUp = (e: ReactPointerEvent) => {
    const wasSingle = pointers.current.size === 1;
    pointers.current.delete(e.pointerId);
    if (pointers.current.size) return begin();
    gesture.current = null;
    if (dismiss > DISMISS_DRAG_PX) return onClose();
    setDismiss(0);
    if (!wasSingle) return;
    const now = Date.now();
    if (now - lastTap.current < DOUBLE_TAP_MS) {
      lastTap.current = 0;
      setView((v) => toggleZoom(v, local({ x: e.clientX, y: e.clientY })));
    } else {
      lastTap.current = now;
    }
  };

  const onWheel = (e: WheelEvent) => {
    const factor = Math.exp(-e.deltaY / 300);
    setView((v) => clampPan(zoomAt(v, v.scale * factor, local({ x: e.clientX, y: e.clientY })), box()));
  };

  return (
    <div className="photo-viewer" role="dialog" aria-label="Photo" style={{ background: `rgba(0, 0, 0, ${0.92 - Math.min(dismiss / 600, 0.5)})` }}>
      <div
        ref={stage}
        className="photo-stage"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onWheel={onWheel}
      >
        <img
          src={url}
          alt=""
          draggable={false}
          style={{
            transform: `translate(${view.x}px, ${view.y + dismiss}px) scale(${view.scale * (1 - Math.min(dismiss / 1500, 0.2))})`,
            transition: gesture.current ? "none" : "transform 0.25s ease",
          }}
        />
      </div>
      <button type="button" className="photo-close" onClick={onClose} aria-label="Close photo">✕</button>
    </div>
  );
}
