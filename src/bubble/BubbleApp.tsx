import { useEffect, useRef, useState } from "react";
import { YoutubeCard } from "../editor/linkCard";
import { youtubeId } from "../lib/linkPreview";

/** Mac: the floating bubble window. A glass drop; click it (or ⌘⇧J) for a mini capture panel that saves to today. */
export function BubbleApp() {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [clip, setClip] = useState("");
  const [saved, setSaved] = useState(false);
  const press = useRef<{ x: number; y: number; dragged: boolean } | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  const resize = async (expanded: boolean) => {
    const { getCurrentWindow, LogicalSize } = await import("@tauri-apps/api/window");
    await getCurrentWindow().setSize(new LogicalSize(expanded ? 340 : 64, expanded ? 320 : 64));
  };
  const expand = async () => {
    await resize(true);
    setOpen(true);
    setSaved(false);
    try {
      const { readText } = await import("@tauri-apps/plugin-clipboard-manager");
      setClip(((await readText()) ?? "").trim());
    } catch {
      setClip("");
    }
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().setFocus();
    setTimeout(() => input.current?.focus(), 50);
  };
  const collapse = async () => {
    setOpen(false);
    setText("");
    await resize(false);
  };
  const save = async (note: string) => {
    if (!note.trim()) return;
    const { emitTo } = await import("@tauri-apps/api/event");
    await emitTo("main", "bubble-note", { text: note.trim(), at: Date.now() });
    setSaved(true);
    setTimeout(() => void collapse(), 700);
  };

  useEffect(() => {
    document.documentElement.classList.add("bubble-window");
    let off: (() => void) | undefined;
    void import("@tauri-apps/api/event").then(({ listen }) => listen("bubble-expand", () => void expand()).then((u) => (off = u)));
    return () => off?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!open) {
    return (
      <button
        type="button"
        className="mac-drop"
        aria-label="Quick capture"
        onMouseDown={(e) => (press.current = { x: e.screenX, y: e.screenY, dragged: false })}
        onMouseMove={async (e) => {
          const p = press.current;
          if (!p || p.dragged || Math.hypot(e.screenX - p.x, e.screenY - p.y) < 4) return;
          p.dragged = true;
          const { getCurrentWindow } = await import("@tauri-apps/api/window");
          await getCurrentWindow().startDragging();
        }}
        onMouseUp={() => {
          const p = press.current;
          press.current = null;
          if (p && !p.dragged) void expand();
        }}
      >
        ✎
      </button>
    );
  }
  const clipIsLink = /^https?:\/\/\S+$/.test(clip);
  return (
    <div className="mac-capture" onKeyDown={(e) => e.key === "Escape" && void collapse()}>
      <div className="mac-capture-head" data-tauri-drag-region>
        <strong data-tauri-drag-region>✏️ Quick note to today</strong>
        <button type="button" onClick={() => void collapse()} aria-label="Close">✕</button>
      </div>
      <textarea
        ref={input}
        value={text}
        placeholder="Write something…"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === "Enter" && void save(text)}
      />
      {clip && clip !== text && (
        <div className="mac-capture-clip">
          {clipIsLink && youtubeId(clip) ? <YoutubeCard url={clip} /> : <span className="paste-preview">📋 {clip.slice(0, 60)}</span>}
          <button type="button" onClick={() => void save(clip)}>{clipIsLink && youtubeId(clip) ? "Save video" : "Save clipboard"}</button>
        </div>
      )}
      <div className="mac-capture-actions">
        {saved ? <span className="settings-ok">✓ Added to today</span> : <span className="hint">⌘↩ to save</span>}
        <button type="button" onClick={() => void save(text)} disabled={!text.trim()}>Add to today</button>
      </div>
    </div>
  );
}
