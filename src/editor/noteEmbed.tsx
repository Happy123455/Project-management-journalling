import { useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { JSONContent } from "@tiptap/react";
import { DocView } from "../pages/DocView";
import { isDayTarget, sectionOf, splitTarget, targetLabel } from "../lib/noteLinks";
import { noteDoc } from "./linkSuggest";

/** Opens a [[link]] target (day or page, with a part) from anywhere: App listens. */
export function openLinkTarget(target: string) {
  window.dispatchEvent(new CustomEvent("journal:open-link", { detail: target }));
}

/**
 * ![[2026-11-03]] or ![[Ravi#Plans]]: that note (or part of it) shown inline, read-only, as it
 * is now; it follows edits there (after a save or a sync). Tap the title to go to it.
 */
export function NoteEmbed({ target }: { target: string }) {
  const { note, section } = splitTarget(target);
  const [doc, setDoc] = useState<JSONContent[] | null | undefined>(undefined);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let live = true;
    const load = () =>
      void noteDoc(note).then((d) => {
        if (!live) return;
        const blocks = d ? (section ? sectionOf(d, section) : (d.content ?? []).filter((b) => b.content?.length || b.type !== "paragraph")) : null;
        setDoc(blocks);
      });
    load();
    window.addEventListener("journal:synced", load);
    window.addEventListener("journal:saved", load);
    return () => {
      live = false;
      window.removeEventListener("journal:synced", load);
      window.removeEventListener("journal:saved", load);
    };
  }, [note, section]);
  const long = (doc?.length ?? 0) > 6;
  return (
    <div className={`note-embed${open ? " open" : ""}`} contentEditable={false}>
      <button type="button" className="note-embed-head" onClick={() => openLinkTarget(target)} title="Open">
        <span>{isDayTarget(note) ? "📅" : "📄"} {targetLabel(target)}</span>
        <span className="note-embed-go">Open ›</span>
      </button>
      <div className="note-embed-body">
        {doc === undefined ? (
          <p className="hint">Loading…</p>
        ) : !doc?.length ? (
          <p className="hint">{doc === null && section ? `No part called “${section}” there yet.` : "Nothing written there yet."}</p>
        ) : (
          <DocView content={open || !long ? doc : doc.slice(0, 6)} compact onOpenLink={openLinkTarget} />
        )}
      </div>
      {long && (
        <button type="button" className="note-embed-more" onClick={() => setOpen(!open)}>
          {open ? "▴ Show less" : `▾ Show all (${doc!.length} blocks)`}
        </button>
      )}
    </div>
  );
}

/** A DOM element with the embed drawn in it (for the editor's widget), and how to clear it. */
export function mountNoteEmbed(target: string): { dom: HTMLElement; destroy: () => void } {
  const dom = document.createElement("div");
  dom.className = "note-embed-host";
  dom.contentEditable = "false";
  const root: Root = createRoot(dom);
  root.render(<NoteEmbed target={target} />);
  return { dom, destroy: () => window.setTimeout(() => root.unmount(), 0) };
}
