/** Editor preferences kept on this device (Settings → Editor). */
export interface EditorPrefs {
  /** Code blocks: scroll sideways (true) or wrap long lines (false). */
  codeScroll: boolean;
  /** Older days: add a "edited" stamp when writing in them. */
  editStamps: boolean;
  /** The note header shows how long ago (or until) the open day is. */
  relativeTime: boolean;
}

const KEY = "journal.editor";
const DEFAULTS: EditorPrefs = { codeScroll: true, editStamps: true, relativeTime: true };

export function editorPrefs(): EditorPrefs {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
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
