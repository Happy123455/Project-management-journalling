import { useEffect } from "react";

/** Mac: how wide the left menu and the right panel are, dragged by their edge and kept on this device. */
const KEY = "journal.panelWidths";
const LIMITS = { left: [180, 520], right: [200, 520] } as const;
const DEFAULTS = { left: 260, right: 260 };
type Side = keyof typeof DEFAULTS;

export function loadWidths(): Record<Side, number> {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    const pick = (s: Side) => (Number.isFinite(v[s]) ? clampWidth(s, v[s]) : DEFAULTS[s]);
    return { left: pick("left"), right: pick("right") };
  } catch {
    return { ...DEFAULTS };
  }
}

export const clampWidth = (side: Side, w: number) => Math.round(Math.min(LIMITS[side][1], Math.max(LIMITS[side][0], w)));

function apply(w: Record<Side, number>) {
  const root = document.documentElement.style;
  root.setProperty("--left-w", `${w.left}px`);
  root.setProperty("--right-w", `${w.right}px`);
}

function save(w: Record<Side, number>) {
  try {
    localStorage.setItem(KEY, JSON.stringify(w));
  } catch {
    // Only a convenience.
  }
}

/** Sets the saved widths on load. */
export function usePanelWidths() {
  useEffect(() => apply(loadWidths()), []);
}

/** The thin grab strip on a panel's inner edge: drag to resize, double-click for the default width. */
export function PanelResizer({ side }: { side: Side }) {
  return (
    <div
      className={`panel-resizer ${side}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={side === "left" ? "Resize the menu" : "Resize the side panel"}
      title="Drag to resize · double-click to reset"
      onDoubleClick={() => {
        const w = { ...loadWidths(), [side]: DEFAULTS[side] };
        apply(w);
        save(w);
      }}
      onPointerDown={(e) => {
        e.preventDefault();
        const el = e.currentTarget;
        el.setPointerCapture(e.pointerId);
        const start = { x: e.clientX, w: loadWidths() };
        document.documentElement.classList.add("panel-resizing");
        const move = (ev: PointerEvent) => {
          const dx = ev.clientX - start.x;
          const w = { ...start.w, [side]: clampWidth(side, start.w[side] + (side === "left" ? dx : -dx)) };
          apply(w);
        };
        const up = (ev: PointerEvent) => {
          el.removeEventListener("pointermove", move);
          el.removeEventListener("pointerup", up);
          el.removeEventListener("pointercancel", up);
          document.documentElement.classList.remove("panel-resizing");
          const dx = ev.clientX - start.x;
          save({ ...start.w, [side]: clampWidth(side, start.w[side] + (side === "left" ? dx : -dx)) });
        };
        el.addEventListener("pointermove", move);
        el.addEventListener("pointerup", up);
        el.addEventListener("pointercancel", up);
      }}
    />
  );
}
