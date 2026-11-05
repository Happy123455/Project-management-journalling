import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/react";
import { noteTyped, onTypingHot, isTypingHot } from "./typingGuide";

/**
 * Feeds the typing speed guide from this editor, and while typing is too fast draws a red glow
 * over the cursor (the caret itself turns red through the `typing-hot` class in CSS).
 */
export function HotCaret({ editor }: { editor: Editor }) {
  const [hot, setHot] = useState(isTypingHot);
  const [at, setAt] = useState<{ left: number; top: number; height: number } | null>(null);

  useEffect(() => onTypingHot(setHot), []);

  useEffect(() => {
    const onTr = ({ transaction: tr }: { transaction: import("@tiptap/pm/state").Transaction }) => {
      if (!tr.docChanged || !editor.isFocused) return;
      const ui = tr.getMeta("uiEvent");
      if (ui === "paste" || ui === "drop" || tr.getMeta("addToHistory") === false) return;
      // What the keys put in: each step's inserted text minus what it replaced. Auto-correct and
      // suggestions swap a whole word at once (a big jump), which the guide leaves out.
      const added = tr.doc.content.size - tr.before.content.size;
      if (added > 0 && tr.steps.length <= 2) noteTyped(added);
    };
    editor.on("transaction", onTr);
    return () => {
      editor.off("transaction", onTr);
    };
  }, [editor]);

  useEffect(() => {
    if (!hot) return setAt(null);
    let frame = 0;
    const place = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (editor.isDestroyed || !editor.isFocused) return setAt(null);
        try {
          const r = editor.view.coordsAtPos(editor.state.selection.head);
          setAt({ left: r.left, top: r.top, height: Math.max(14, r.bottom - r.top) });
        } catch {
          setAt(null);
        }
      });
    };
    place();
    editor.on("selectionUpdate", place);
    editor.on("update", place);
    window.addEventListener("scroll", place, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      editor.off("selectionUpdate", place);
      editor.off("update", place);
      window.removeEventListener("scroll", place);
    };
  }, [hot, editor]);

  if (!hot || !at) return null;
  return createPortal(
    <span className="hot-caret" aria-hidden style={{ transform: `translate3d(${at.left - 1}px, ${at.top}px, 0)`, height: at.height }} />,
    document.body,
  );
}
