import type { JSONContent } from "@tiptap/react";
import { mergeDocs, takeMergeNotes } from "./merge";
import { logAnomaly, short } from "./anomalies";

/**
 * A save from the open editor can only take out lines that editor has seen. The editor saves the
 * whole note; when sync (or the other device's live typing) put lines into the stored note that
 * this editor never showed, a plain save wrote over them. On 8 Nov the phone's save removed
 * "next front" while the Mac was typing it, and undid a fix made on the Mac a second before.
 * Now the save is merged three ways: the editor's note, the stored note, and the note the editor
 * started from (sync/merge.ts mergeDocs), so lines only the store has are kept.
 */
const seen = new Map<string, string>();

/** The editor (re)opened a note with this content, or had it put in place. */
export function editorSaw(key: string, doc: JSONContent | null | undefined) {
  if (doc) seen.set(key, JSON.stringify(doc));
  else seen.delete(key);
}

/** What to store for the editor's `content`, given what's stored now. */
export function guardSave(key: string, content: JSONContent, stored: JSONContent | null | undefined): JSONContent {
  const base = seen.get(key);
  seen.set(key, JSON.stringify(content));
  if (!base || !stored) return content;
  const storedKey = JSON.stringify(stored);
  if (storedKey === base || storedKey === JSON.stringify(content)) return content;
  takeMergeNotes();
  const out = mergeDocs(content, stored, JSON.parse(base) as JSONContent, true);
  try {
    const found = takeMergeNotes();
    logAnomaly({ kind: "stale-save", path: "save", note: key, text: `the open note was behind the stored one; merged (${found.length} line note${found.length === 1 ? "" : "s"})`, detail: { lines: (stored.content?.length ?? 0) + " stored / " + (content.content?.length ?? 0) + " in editor" } });
    for (const n of found) logAnomaly({ kind: n.kind, path: "save", note: key, text: Object.entries(n.texts).map(([k, v]) => `${k}: "${short(v, 60)}"`).join(" / "), detail: { line: n.line, texts: n.texts } });
  } catch {
    // never stops a save
  }
  return out;
}
