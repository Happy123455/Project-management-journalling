/** What a swipe across the note does (Settings → Gestures). The week strip's swipes are fixed. */
export type CanvasAction = "none" | "end" | "top" | "today" | "prev" | "next" | "search" | "capture";

export const CANVAS_ACTIONS: { value: CanvasAction; label: string }[] = [
  { value: "prev", label: "Previous day" },
  { value: "next", label: "Next day" },
  { value: "today", label: "Today" },
  { value: "end", label: "Go to end of note" },
  { value: "top", label: "Go to top" },
  { value: "search", label: "Search" },
  { value: "capture", label: "Quick capture" },
  { value: "none", label: "Nothing" },
];

export interface Gestures {
  /** Finger moving left → right. */
  right: CanvasAction;
  /** Finger moving right → left. */
  left: CanvasAction;
}

const KEY = "dynamic-journal.gestures";
const DEFAULTS: Gestures = { right: "prev", left: "next" };

export function loadGestures(): Gestures {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    const ok = (a: unknown): a is CanvasAction => CANVAS_ACTIONS.some((c) => c.value === a);
    return { right: ok(v.right) ? v.right : DEFAULTS.right, left: ok(v.left) ? v.left : DEFAULTS.left };
  } catch {
    return DEFAULTS;
  }
}

export function saveGestures(g: Gestures) {
  try {
    localStorage.setItem(KEY, JSON.stringify(g));
  } catch {
    // Only a convenience.
  }
}

/**
 * Surfaces that pan or draw under the finger (Canvas mode, mind maps, graphs, photos, handwriting):
 * a drag there moves the surface, never the day, the week strip or "pull for today".
 */
export const PAN_SURFACES = ".note-canvas, .nc-stage, .mindmap-canvas, .graph-canvas, .photo-stage, .handwriting-canvas, .sheet-grid, .gantt-pane, .tl-view";

/** True when a touch starts on a surface that pans (see PAN_SURFACES). */
export const onPanSurface = (target: EventTarget | null) => !!(target as HTMLElement | null)?.closest?.(PAN_SURFACES);

/** Swipes that start here are someone using that control, not a gesture. */
export const NO_SWIPE = PAN_SURFACES + ", .nav-island, .nav-quick, .nav-previews, .nav-joystick, .slash-popup, .link-suggest, .block-menu, .block-handle, .search-panel, .paste-chip, .arrange-tools, .keyboard-bar, .attach-toolbar, .attach-resize, .year-panel, .drawer, .routine-panel, .outline-backdrop, input, textarea, video, audio, canvas, iframe, img, .yt-embed, .attach-image, .attach-file, .pdf-preview, .link-card, .yt-card, pre, .math-block, .pm-formula, .katex, .katex-display, .code-block, .dl, .ds, .tdl, .tl-cols, .tl-all, .tl-list";
