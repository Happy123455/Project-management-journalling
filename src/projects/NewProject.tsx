import { useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { showError, showToast } from "../lib/toast";
import type { JournalStore } from "../store";

/** The "/" Project tile: name it, and it becomes an active project linked from where you are. */
export function NewProject({ store }: { store: JournalStore | null }) {
  const [editor, setEditor] = useState<Editor | null>(null);
  const [name, setName] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onOpen = (e: Event) => {
      setEditor((e as CustomEvent<{ editor: Editor }>).detail.editor);
      setName("");
    };
    window.addEventListener("journal:new-project", onOpen);
    return () => window.removeEventListener("journal:new-project", onOpen);
  }, []);
  useEffect(() => {
    if (editor) input.current?.focus();
  }, [editor]);
  if (!editor || !store) return null;

  const create = async () => {
    const title = name.trim();
    if (!title) return;
    try {
      const page = await store.ensurePage(title);
      await store.setPageProps(page.id, { project: { status: "active" } });
      editor.chain().focus().insertContent(`[[${title}]] `).run();
      showToast(`Project “${title}” created`);
      setEditor(null);
    } catch (e) {
      showError("Couldn't create the project", e);
    }
  };

  return (
    <>
      <div className="search-backdrop" onClick={() => setEditor(null)} />
      <form
        className="confirm-card"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <h2>📌 New project</h2>
        <input ref={input} className="project-name-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Project name" />
        <p className="hint">Tasks anywhere with [[{name.trim() || "Name"}]] or its #tag roll up to the project.</p>
        <div className="confirm-actions">
          <button type="button" onClick={() => setEditor(null)}>Cancel</button>
          <button type="submit" disabled={!name.trim()}>Create</button>
        </div>
      </form>
    </>
  );
}
