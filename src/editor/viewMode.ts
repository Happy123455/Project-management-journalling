import { useEffect, useState } from "react";

/**
 * How notes are shown: Live (the editor as it was), Source (plain characters), Reading (no editing)
 * or Canvas (the note as a mind map growing over time, src/canvas).
 */
export type ViewMode = "live" | "source" | "reading" | "canvas";

const KEY = "journal.viewMode";
const EVENT = "journal:view-mode";

/**
 * Canvas belongs to the note it was opened on and isn't remembered across restarts: another note
 * opens the way it was before (see leaveCanvasIfOther).
 */
let canvas: { note: string | null; before: ViewMode } | null = null;
let activeNote: string | null = null;

export function viewMode(): ViewMode {
  if (canvas) return "canvas";
  try {
    const v = localStorage.getItem(KEY);
    return v === "source" || v === "reading" ? v : "live";
  } catch {
    return "live";
  }
}

export function setViewMode(mode: ViewMode) {
  if (mode === "canvas") {
    if (!canvas) canvas = { note: activeNote, before: storedMode() };
    else canvas.note = activeNote;
    window.dispatchEvent(new CustomEvent(EVENT, { detail: mode }));
    return;
  }
  canvas = null;
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    // Kept for this session only.
  }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: mode }));
}

function storedMode(): ViewMode {
  try {
    const v = localStorage.getItem(KEY);
    return v === "source" || v === "reading" ? v : "live";
  } catch {
    return "live";
  }
}

/** The note Canvas is open on (null when Canvas is off). */
export const canvasNote = (): string | null => (canvas ? canvas.note : null);

/** The mode before Canvas was opened (Canvas's "back to the note"). */
export const modeBeforeCanvas = (): ViewMode => canvas?.before ?? storedMode();

/**
 * A note's editor opening: it becomes the note Canvas opens for, and if Canvas was open on another
 * note, that note's mode comes back (a mind map isn't sprung on the next note opened).
 */
export function leaveCanvasIfOther(note: string) {
  activeNote = note;
  if (canvas && canvas.note === null) canvas.note = note;
  else if (canvas && canvas.note !== note) setViewMode(canvas.before);
}

/** The current mode, following changes made anywhere (a toolbar button, the mode pill, a shortcut). */
export function useViewMode(): ViewMode {
  const [mode, setMode] = useState(viewMode);
  useEffect(() => {
    const on = (e: Event) => setMode((e as CustomEvent<ViewMode>).detail ?? viewMode());
    window.addEventListener(EVENT, on);
    // A change made before this listener was attached (a note leaving Canvas as it opens).
    setMode(viewMode());
    return () => window.removeEventListener(EVENT, on);
  }, []);
  return mode;
}

export const openOutline = () => window.dispatchEvent(new Event("journal:outline"));
