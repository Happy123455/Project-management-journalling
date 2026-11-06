import { useEffect, useState } from "react";

/** How notes are shown: Live (the editor as it was), Source (plain characters) or Reading (no editing). */
export type ViewMode = "live" | "source" | "reading";

const KEY = "journal.viewMode";
const EVENT = "journal:view-mode";

export function viewMode(): ViewMode {
  try {
    const v = localStorage.getItem(KEY);
    return v === "source" || v === "reading" ? v : "live";
  } catch {
    return "live";
  }
}

export function setViewMode(mode: ViewMode) {
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    // Kept for this session only.
  }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: mode }));
}

/** The current mode, following changes made anywhere (a toolbar button, the mode pill, a shortcut). */
export function useViewMode(): ViewMode {
  const [mode, setMode] = useState(viewMode);
  useEffect(() => {
    const on = (e: Event) => setMode((e as CustomEvent<ViewMode>).detail ?? viewMode());
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
  return mode;
}

export const openOutline = () => window.dispatchEvent(new Event("journal:outline"));
