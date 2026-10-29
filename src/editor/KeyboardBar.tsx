import { useEffect, useState, type ReactNode } from "react";
import type { Editor } from "@tiptap/react";

/** True on phones and tablets, where the toolbar sits above the on-screen keyboard. */
export function useTouchDevice(): boolean {
  const query = "(pointer: coarse)";
  const [touch, setTouch] = useState(() => window.matchMedia?.(query).matches ?? false);
  useEffect(() => {
    const media = window.matchMedia?.(query);
    if (!media) return;
    const onChange = () => setTouch(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);
  return touch;
}

/** Bottom edge of the visible area, which moves up when the keyboard opens. */
function useVisibleBottom(): { bottom: number; keyboardOpen: boolean } {
  const read = () => {
    const vv = window.visualViewport;
    const bottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
    // The keyboard takes well over 150px; smaller changes are browser bars.
    const keyboardOpen = window.screen.height - (vv?.height ?? window.innerHeight) > 250;
    // For sheets that sit above the keyboard (the "/" menu): how much it covers, and the visible height.
    const root = document.documentElement.style;
    root.setProperty("--kb-inset", `${Math.max(0, window.innerHeight - bottom)}px`);
    root.setProperty("--vvh", `${vv?.height ?? window.innerHeight}px`);
    return { bottom, keyboardOpen };
  };
  const [state, setState] = useState(read);
  useEffect(() => {
    const vv = window.visualViewport;
    const update = () => setState(read());
    vv?.addEventListener("resize", update);
    vv?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    return () => {
      vv?.removeEventListener("resize", update);
      vv?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, []);
  return state;
}

/** Slim formatting bar pinned just above the phone keyboard while the editor has focus. */
export function KeyboardBar({ editor, children }: { editor: Editor; children: ReactNode }) {
  const [focused, setFocused] = useState(editor.isFocused);
  const { bottom, keyboardOpen } = useVisibleBottom();

  useEffect(() => {
    const onFocus = () => setFocused(true);
    const onBlur = () => setFocused(false);
    editor.on("focus", onFocus);
    editor.on("blur", onBlur);
    return () => {
      editor.off("focus", onFocus);
      editor.off("blur", onBlur);
    };
  }, [editor]);

  // Keep the line being typed visible above the bar.
  useEffect(() => {
    if (focused && keyboardOpen) editor.commands.scrollIntoView();
  }, [focused, keyboardOpen, bottom, editor]);

  if (!focused) return null;
  return (
    <div
      className={keyboardOpen ? "keyboard-bar keyboard-open" : "keyboard-bar"}
      role="toolbar"
      aria-label="Formatting"
      style={{ top: `${bottom}px` }}
    >
      {children}
    </div>
  );
}
