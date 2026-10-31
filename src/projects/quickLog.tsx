import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/react";
import { TextSelection } from "@tiptap/pm/state";
import { loadAiSettings } from "../ai/settings";
import { OLLAMA_URL } from "../ai/providers";
import { isDesktopApp } from "../bubble/macBubble";
import { journalStore } from "../editor/attachments";
import { showError, showToast } from "../lib/toast";
import type { JournalStore, NamedPage } from "../store";

/** A quick-log button: the project it logs into and its icon. */
export interface QuickLog {
  id: string;
  title: string;
  icon: string | null;
}

export const QUICK_LOG_CHANGED = "journal:quick-log";

export async function quickLogs(store: JournalStore): Promise<QuickLog[]> {
  return (await store.projects())
    .filter((p) => p.props.project?.quickLog && p.props.project.status !== "done")
    .map((p) => ({ id: p.id, title: p.title, icon: p.props.project?.icon ?? null }));
}

/**
 * One tap: a [[Project]] box with an indented line under it, the cursor in that line. Goes in the
 * empty line the cursor is on, or right after the block it's in (never splitting a sentence).
 */
export function insertQuickLog(editor: Editor, title: string) {
  const { state } = editor;
  const { $from } = state.selection;
  const top = $from.depth >= 1 ? $from.before(1) : 0;
  const block = state.doc.nodeAt(top);
  const emptyLine = block?.type.name === "paragraph" && block.content.size === 0;
  const at = emptyLine ? top : block ? top + block.nodeSize : state.doc.content.size;
  const nodes = [
    { type: "paragraph", content: [{ type: "text", text: `[[${title}]]` }] },
    { type: "paragraph", attrs: { indent: 1 } },
  ];
  const range = emptyLine && block ? { from: top, to: top + block.nodeSize } : at;
  editor.chain().focus().insertContentAt(range, nodes).run();
  // Into the indented line: the first paragraph after the inserted title.
  const doc = editor.state.doc;
  const titleNode = doc.nodeAt(at);
  if (!titleNode) return;
  const line = at + titleNode.nodeSize + 1;
  if (line <= doc.content.size) editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(doc, line)).scrollIntoView());
}

const EMOJI = [
  "🏋️", "🏃", "🧘", "🚴", "🏊", "⚽", "🥗", "💧", "☕", "🍳", "😴", "💊",
  "📚", "✍️", "🎸", "🎨", "📷", "🎮", "💻", "🧠", "🗣️", "🌱", "🧹", "🛒",
  "💰", "📈", "🧾", "✈️", "🚗", "🏠", "👨‍👩‍👧", "❤️", "🙏", "🎯", "⏱️", "📌",
];

/** Asks the Mac's quick local model (llama3.2) for one emoji that fits the project. */
export async function suggestIcon(title: string): Promise<string | null> {
  if (!isDesktopApp()) return null;
  const s = loadAiSettings();
  const model = s.models.local?.grammar || "llama3.2";
  try {
    const http = (await import("@tauri-apps/plugin-http")).fetch;
    const res = await http(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      signal: AbortSignal.timeout(60_000),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        stream: false,
        format: { type: "object", properties: { emoji: { type: "string" } }, required: ["emoji"] },
        options: { temperature: 0.2 },
        messages: [
          { role: "system", content: "You pick one emoji that best stands for a habit or project someone logs in their journal. Answer as JSON {\"emoji\": \"…\"} with exactly one emoji." },
          { role: "user", content: title },
        ],
      }),
    });
    if (!res.ok) return null;
    const body = await res.json();
    const emoji = String(JSON.parse(body.message?.content ?? "{}").emoji ?? "").trim();
    // One emoji (with its joiners and variation marks), nothing else.
    return /\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier}|\u200D\p{Extended_Pictographic}\uFE0F?)*/u.exec(emoji)?.[0] ?? null;
  } catch {
    return null;
  }
}

/** Mac: gives every quick log waiting for an AI icon its icon (as the model's own edit, so it can be undone). */
export async function assignQuickLogIcons(store: JournalStore): Promise<number> {
  if (!isDesktopApp()) return 0;
  let n = 0;
  for (const p of await store.projects()) {
    const info = p.props.project;
    if (!info?.quickLog || !info.iconAuto || info.icon) continue;
    const icon = await suggestIcon(p.title);
    if (!icon) continue;
    const model = loadAiSettings().models.local?.grammar || "llama3.2";
    await store.setPageProps(p.id, { project: { ...info, icon } }, `Local (${model.split(":")[0]})`);
    n++;
  }
  if (n) window.dispatchEvent(new Event(QUICK_LOG_CHANGED));
  return n;
}

/** The quick-log buttons for the tool bar, kept current. */
export function useQuickLogs(): QuickLog[] {
  const [list, setList] = useState<QuickLog[]>([]);
  useEffect(() => {
    let live = true;
    const load = () => {
      const store = journalStore();
      if (store) void quickLogs(store).then((l) => live && setList(l)).catch(() => {});
    };
    load();
    window.addEventListener(QUICK_LOG_CHANGED, load);
    window.addEventListener("journal:synced", load);
    return () => {
      live = false;
      window.removeEventListener(QUICK_LOG_CHANGED, load);
      window.removeEventListener("journal:synced", load);
    };
  }, []);
  return list;
}

export const openQuickLogSetup = () => window.dispatchEvent(new Event("journal:quick-log-setup"));

/** Which projects get a quick-log button, and their icons (picked by hand, or by the Mac's AI). */
export function QuickLogSetup() {
  const [open, setOpen] = useState(false);
  const [projects, setProjects] = useState<NamedPage[]>([]);
  const [picking, setPicking] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const store = journalStore();
  const reload = () => void store?.projects().then((all) => setProjects(all.filter((p) => p.props.project?.status !== "done")));
  useEffect(() => {
    const onOpen = () => {
      setOpen(true);
      setPicking(null);
    };
    window.addEventListener("journal:quick-log-setup", onOpen);
    return () => window.removeEventListener("journal:quick-log-setup", onOpen);
  }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => (open ? reload() : undefined), [open]);
  if (!open || !store) return null;

  const save = async (p: NamedPage, patch: Partial<NonNullable<NamedPage["props"]["project"]>>) => {
    try {
      await store.setPageProps(p.id, { project: { ...p.props.project!, ...patch } });
      window.dispatchEvent(new Event(QUICK_LOG_CHANGED));
      reload();
    } catch (e) {
      showError("Couldn't save the quick log", e);
    }
  };
  const aiPick = async (p: NamedPage) => {
    setPicking(null);
    if (!isDesktopApp()) {
      await save(p, { iconAuto: true, icon: undefined, quickLog: true });
      showToast("The Mac's AI will pick its icon; it arrives with the next sync");
      return;
    }
    setBusy(p.id);
    const icon = await suggestIcon(p.title);
    setBusy(null);
    if (!icon) return showToast("The local model didn't answer; is Ollama running?");
    await save(p, { icon, iconAuto: true, quickLog: true });
  };

  return createPortal(
    <>
      <div className="search-backdrop" onClick={() => setOpen(false)} />
      <div className="confirm-card quick-log-setup" role="dialog" aria-label="Quick log buttons">
        <h2>⚡ Quick log buttons</h2>
        <p className="hint">A button on the tool bar adds the project's box with one tap, ready to write in.</p>
        {projects.length === 0 && <p className="hint">No projects yet: make one from the “/” menu (Project or Log).</p>}
        <ul className="quick-log-list">
          {projects.map((p) => {
            const info = p.props.project!;
            return (
              <li key={p.id}>
                <button type="button" className="quick-log-icon" onClick={() => setPicking(picking === p.id ? null : p.id)} aria-label={`Icon for ${p.title}`}>
                  {busy === p.id ? "…" : info.icon ?? (info.iconAuto ? "✨" : "＋")}
                </button>
                <span className="quick-log-title">
                  {p.title}
                  {info.iconAuto && !info.icon && <small>Icon: the Mac's AI picks it</small>}
                </span>
                <label className="settings-toggle quick-log-toggle">
                  <input type="checkbox" checked={!!info.quickLog} onChange={(e) => void save(p, { quickLog: e.target.checked })} />
                </label>
                {picking === p.id && (
                  <div className="quick-log-emoji">
                    <button type="button" className="quick-log-ai" onClick={() => void aiPick(p)}>✨ Let the Mac's AI pick</button>
                    {EMOJI.map((e) => (
                      <button key={e} type="button" onClick={() => (setPicking(null), void save(p, { icon: e, iconAuto: false, quickLog: true }))}>
                        {e}
                      </button>
                    ))}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        <div className="confirm-actions">
          <button type="button" onClick={() => setOpen(false)}>Done</button>
        </div>
      </div>
    </>,
    document.body,
  );
}
