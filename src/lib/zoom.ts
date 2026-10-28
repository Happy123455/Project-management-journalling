export interface View {
  scale: number;
  x: number;
  y: number;
}

export const MIN_SCALE = 1;
export const MAX_SCALE = 6;
export const DOUBLE_TAP_SCALE = 2.5;

export const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

/**
 * Zooms to `scale` while keeping the content point under `focus` (relative to the centre
 * of the picture's box) where it is on screen.
 */
export function zoomAt(view: View, scale: number, focus: { x: number; y: number }): View {
  const next = clampScale(scale);
  if (next === MIN_SCALE) return { scale: 1, x: 0, y: 0 };
  const k = next / view.scale;
  return { scale: next, x: focus.x - (focus.x - view.x) * k, y: focus.y - (focus.y - view.y) * k };
}

/** Double-tap: zoom in on the tapped point, or back out when already zoomed. */
export function toggleZoom(view: View, focus: { x: number; y: number }): View {
  return view.scale > 1.01 ? { scale: 1, x: 0, y: 0 } : zoomAt(view, DOUBLE_TAP_SCALE, focus);
}

/** Keeps a zoomed picture from being dragged entirely off screen. */
export function clampPan(view: View, box: { width: number; height: number }): View {
  const maxX = ((view.scale - 1) * box.width) / 2;
  const maxY = ((view.scale - 1) * box.height) / 2;
  return { ...view, x: Math.min(maxX, Math.max(-maxX, view.x)), y: Math.min(maxY, Math.max(-maxY, view.y)) };
}
