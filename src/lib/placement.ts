export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

const MARGIN = 8;

/**
 * Where to put a placement bar of `bar` size for a picture at `target` (both in screen
 * coordinates) so it stays inside a `viewport` wide and tall: centred above the picture,
 * slid sideways at the screen edges, and flipped below when there's no room above.
 * Returns the offset from the picture's top-left corner.
 */
export function placeBar(target: Rect, bar: { width: number; height: number }, viewport: { width: number; height: number; top?: number }, gap = 6) {
  const minTop = (viewport.top ?? 0) + MARGIN;
  let left = target.left + target.width / 2 - bar.width / 2;
  left = Math.min(Math.max(left, MARGIN), viewport.width - MARGIN - bar.width);
  let top = target.top - gap - bar.height;
  const below = target.top + target.height + gap;
  if (top < minTop) top = below + bar.height <= viewport.height - MARGIN ? below : Math.max(minTop, target.top + gap);
  return { x: Math.round(left - target.left), y: Math.round(top - target.top), flipped: top >= target.top };
}
