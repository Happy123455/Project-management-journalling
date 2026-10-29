import { useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { showError, showToast } from "../lib/toast";
import { MAX_ACTIVE_PROJECTS } from "../lib/projects";
import type { JournalStore, NamedPage } from "../store";

/** The "/" Project tile: name it, and it becomes an active project linked from where you are. */
export function NewProject({ store }: { store: JournalStore | null }) {
  const [editor, setEditor] = useState<Editor | null>(null);
  const [name, setName] = useState("");
  // When 4 are already active: those, so one can be paused to make room.
  const [full, setFull] = useState<NamedPage[]>([]);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onOpen = (e: Event) => {
      setEditor((e as CustomEvent<{ editor: Editor }>).detail.editor);
      setName("");
      void store?.projects().then((all) => {
        const active = all.filter((p) => (p.props.project?.status ?? "active") === "active");
        setFull(active.length >= MAX_ACTIVE_PROJECTS ? active : []);
      });
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
        {full.length > 0 && (
          <div className="project-full">
            <p>{MAX_ACTIVE_PROJECTS} projects are already active. Pause one to start this one:</p>
            {full.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={async () => {
                  await store.setPageProps(p.id, { project: { status: "paused" } });
                  showToast(`“${p.title}” paused`);
                  setFull([]);
                }}
              >
                ⏸ {p.title}
              </button>
            ))}
          </div>
        )}
        <div className="confirm-actions">
          <button type="button" onClick={() => setEditor(null)}>Cancel</button>
          <button type="submit" disabled={!name.trim() || full.length > 0}>Create</button>
        </div>
      </form>
    </>
  );
}
