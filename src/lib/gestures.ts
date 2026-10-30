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

/** Swipes that start here are someone using that control, not a gesture. */
export const NO_SWIPE = ".slash-popup, .link-suggest, .block-menu, .block-handle, .search-panel, .paste-chip, .arrange-tools, .keyboard-bar, .attach-toolbar, .attach-resize, .year-panel, .drawer, input, textarea, video, audio, canvas, iframe, img, .yt-embed, .attach-image, .attach-file, .pdf-preview, .link-card, .yt-card, pre, .month-calendar.floating";
