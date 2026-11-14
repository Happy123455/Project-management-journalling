import { useEffect, useState } from "react";

/** Editor preferences kept on this device (Settings → Editor). */
export interface EditorPrefs {
  /** Code blocks: scroll sideways (true) or wrap long lines (false). */
  codeScroll: boolean;
  /** Older days: add a "edited" stamp when writing in them. */
  editStamps: boolean;
  /** The note header shows how long ago (or until) the open day is. */
  relativeTime: boolean;
  /** Typing "=" after a sum ("12+12=") writes the answer. */
  autoMath: boolean;
  /** Plain maths in the text ("(a+b)/2", "x^2") is drawn as a formula (the text stays as typed). */
  prettyMath: boolean;
  /** Typing speed guide: typing faster than `maxCps` makes the cursor hot and buzzes the phone. */
  typingGuide: boolean;
  /** The most characters per second the guide allows. */
  maxCps: number;
  /** Month view: "⏳ Deadlines today" under Coming up, to its left, or not at all. */
  monthDeadlines: "below" | "left" | "off";
  /** Going to a timestamp from the time rail lights its line in that time of day's colour for 4 s. */
  timeFlash: boolean;
  /** Month calendar: festivals, birthdays and anniversaries get a small ambient animation on their tile. */
  festiveTiles: boolean;
}

/** Follows the prefs (Settings changes them while the app runs). */
export function useEditorPrefs(): EditorPrefs {
  const [p, setP] = useState(editorPrefs);
  useEffect(() => {
    const on = () => setP(editorPrefs());
    window.addEventListener("journal:editor-prefs", on);
    return () => window.removeEventListener("journal:editor-prefs", on);
  }, []);
  return p;
}

const KEY = "journal.editor";
const DEFAULTS: EditorPrefs = { codeScroll: true, editStamps: true, relativeTime: true, autoMath: true, prettyMath: true, typingGuide: false, maxCps: 6, monthDeadlines: "below", timeFlash: true, festiveTiles: true };

/** Read on every letter typed (formulas, edit stamps…): parsed again only when the stored text changes. */
let cached: { raw: string | null; prefs: EditorPrefs } | null = null;
export function editorPrefs(): EditorPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (cached?.raw !== raw) cached = { raw, prefs: { ...DEFAULTS, ...JSON.parse(raw ?? "{}") } };
    return { ...cached!.prefs };
  } catch {
    return DEFAULTS;
  }
}

/** Applies the prefs that are pure CSS (a class on <html>). */
export function applyEditorPrefs(p = editorPrefs()) {
  document.documentElement.classList.toggle("code-wrap", !p.codeScroll);
}

export function setEditorPrefs(patch: Partial<EditorPrefs>): EditorPrefs {
  const next = { ...editorPrefs(), ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Blocked storage: the change lasts until the app closes.
  }
  applyEditorPrefs(next);
  window.dispatchEvent(new Event("journal:editor-prefs"));
  return next;
}
