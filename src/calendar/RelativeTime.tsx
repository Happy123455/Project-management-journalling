import { useEffect, useState } from "react";
import { editorPrefs } from "../lib/editorPrefs";
import { relativeLabel, relativeTo } from "../lib/relative";

/** Under the date: how long ago (or how far ahead) the open day is. Tap for days and weeks. */
export function RelativeTime({ day, today }: { day: string; today: string }) {
  const [on, setOn] = useState(() => editorPrefs().relativeTime);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const sync = () => setOn(editorPrefs().relativeTime);
    window.addEventListener("journal:editor-prefs", sync);
    return () => window.removeEventListener("journal:editor-prefs", sync);
  }, []);
  useEffect(() => setOpen(false), [day]);
  if (!on || day === today) return null;
  const r = relativeTo(day, today);
  const weeks = Math.floor(r.total / 7);
  return (
    <button type="button" className={`relative-time${r.future ? " future" : ""}`} onClick={() => setOpen(!open)} aria-expanded={open}>
      <span aria-hidden>{r.future ? "⏳" : "⌛"}</span> {relativeLabel(day, today)}
      {open && (
        <span className="relative-more">
          {" · "}
          {r.total} day{r.total === 1 ? "" : "s"}{weeks >= 1 ? ` · ${weeks} week${weeks === 1 ? "" : "s"}${r.total % 7 ? ` ${r.total % 7} d` : ""}` : ""}
        </span>
      )}
    </button>
  );
}
