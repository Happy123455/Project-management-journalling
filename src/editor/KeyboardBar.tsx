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

/**
 * While a formatting bar is up (typing with the keyboard open), <html> carries `kb-bar-on`, and the
 * navigation island steps aside for it (App.css). Counted, so two bars never fight over the class.
 */
let barsUp = 0;
export function useBarShown(shown: boolean) {
  useEffect(() => {
    if (!shown) return;
    barsUp++;
    document.documentElement.classList.add("kb-bar-on");
    return () => {
      barsUp = Math.max(0, barsUp - 1);
      if (!barsUp) document.documentElement.classList.remove("kb-bar-on");
    };
  }, [shown]);
}

/** Slim formatting bar pinned just above the phone keyboard while typing (the editor has focus and the keyboard is up). */
export function KeyboardBar({ editor, children, layout }: { editor: Editor; children: ReactNode; layout?: { rows?: 1 | 2; style?: "rows" | "strip"; big?: boolean } }) {
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

  // Only while typing: with the keyboard down, the navigation island has this place.
  const shown = focused && keyboardOpen;
  useBarShown(shown);
  if (!shown) return null;
  return (
    <div
      className={`keyboard-bar${keyboardOpen ? " keyboard-open" : ""}${layout?.style === "strip" ? " strip" : layout?.rows === 2 ? " rows-2" : ""}${layout?.big ? " big" : ""}`}
      role="toolbar"
      aria-label="Formatting"
      style={{ top: `${bottom}px` }}
    >
      {children}
    </div>
  );
}
