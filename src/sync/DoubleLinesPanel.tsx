import { useState } from "react";
import type { JournalStore } from "../store";
import { findDoubles, withoutLine, type Double } from "../lib/doubleLines";
import { openDayEditor } from "../editor/noteEdit";
import { docText } from "../lib/words";
import { addDays, dayKey } from "../lib/timestamp";
import { siblingIds } from "./lineIds";
import { showToast } from "../lib/toast";

const KEEP_KEY = "journal.doubles-kept";
const DAYS_BACK = 60;

function kept(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(KEEP_KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}
const keyOf = (d: Double) => `${d.day}|${d.lid}|${d.text.length}`;

/**
 * Nexus › Sync › 🧹 Possible double lines: half-typed copies and duplicates the old sync left in
 * notes of the last two months (and reminder days ahead). Nothing goes unless Hapi taps Remove;
 * a removed line is in Nexus › This note with ↩ like any other.
 */
export function DoubleLinesPanel({ store }: { store: JournalStore | null }) {
  const [list, setList] = useState<Double[] | null>(null);
  const [busy, setBusy] = useState(false);

  const scan = async () => {
    if (!store || busy) return;
    setBusy(true);
    try {
      const from = addDays(dayKey(new Date()), -DAYS_BACK);
      const skip = kept();
      const out: Double[] = [];
      for (const day of (await store.listDays()).filter((d) => d >= from).sort()) {
        const page = await store.getDay(day);
        for (const d of findDoubles(day, page?.content)) if (!skip.has(keyOf(d))) out.push(d);
      }
      setList(out);
    } finally {
      setBusy(false);
    }
  };

  const drop = (d: Double) => setList((l) => l?.filter((x) => x !== d) ?? null);

  const remove = async (d: Double) => {
    if (!store) return;
    const editor = openDayEditor(d.day);
    if (editor) {
      // Open right now: take it out through the editor (an edit like any other, saved as usual).
      let at = -1;
      let size = 0;
      const ids = siblingIds(editor.getJSON().content ?? []);
      editor.state.doc.forEach((n, offset, i) => {
        if (ids[i] === d.lid && n.textContent.replace(/\s+/g, " ").trim() === d.text) (at = offset), (size = n.nodeSize);
      });
      if (at < 0) return void (showToast("That line changed since; look again", "error"), drop(d));
      editor.view.dispatch(editor.state.tr.delete(at, at + size));
    } else {
      const page = await store.getDay(d.day);
      const next = page && withoutLine(page.content, d);
      if (!next) return void (showToast("That line changed since; look again", "error"), drop(d));
      await store.saveDay({ day: d.day, content: next, plainText: docText(next) });
      window.dispatchEvent(new Event("journal:reload-page"));
    }
    showToast("Removed. Nexus › This note can put it back (↩)");
    drop(d);
  };

  const keep = (d: Double) => {
    const s = kept();
    s.add(keyOf(d));
    try {
      localStorage.setItem(KEEP_KEY, JSON.stringify([...s].slice(-500)));
    } catch {
      // Shown again next time.
    }
    drop(d);
  };

  if (!list)
    return (
      <div className="doubles">
        <button type="button" onClick={() => void scan()} disabled={busy || !store}>
          {busy ? "Looking…" : "🧹 Look for double lines"}
        </button>
      </div>
    );
  return (
    <div className="doubles nexus-removed">
      <p className="hint">
        {list.length
          ? `🧹 ${list.length} possible double line${list.length === 1 ? "" : "s"} (half-typed copies and repeats). Remove the extra copy, or Keep to stop seeing it.`
          : "🧹 No double lines found in the last two months."}
      </p>
      {list.map((d) => (
        <div key={keyOf(d)} className="nexus-removed-row doubles-row">
          <span className="nexus-removed-meta">
            {d.day} · {d.why === "half" ? "half-typed copy" : d.why === "copy" ? "same line twice" : "second copy from a sync clash"}
          </span>
          <span className="nexus-removed-text">
            <s>{d.text.slice(0, 200)}</s>
            <br />
            <small>keeps: {d.twin.slice(0, 200)}</small>
          </span>
          <span className="doubles-actions">
            <button type="button" onClick={() => void remove(d)}>Remove</button>
            <button type="button" onClick={() => keep(d)}>Keep</button>
          </span>
        </div>
      ))}
      <button type="button" className="link" onClick={() => void scan()}>Look again</button>
    </div>
  );
}
