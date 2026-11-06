import { useEffect, useRef } from "react";

/** Open panels, newest last: Esc closes only the one on top. */
const stack: { current: () => void }[] = [];

function onKey(e: KeyboardEvent) {
  if (e.key !== "Escape" || e.defaultPrevented || e.isComposing || !stack.length) return;
  // Handled here, so the Mac doesn't also take Esc as "leave full screen".
  e.preventDefault();
  e.stopPropagation();
  stack[stack.length - 1].current();
}

/** Closes the panel on top, as Esc would (the phone's Back does this). False when none is open. */
export function closeTopPanel(): boolean {
  if (!stack.length) return false;
  stack[stack.length - 1].current();
  return true;
}

/**
 * Esc closes this panel (and nothing else: not full screen, not a panel under it). Pass
 * `active = false` while the panel is hidden.
 */
export function useEscapeToClose(onClose: () => void, active = true): void {
  const ref = useRef(onClose);
  ref.current = onClose;
  useEffect(() => {
    if (!active) return;
    if (!stack.length) window.addEventListener("keydown", onKey);
    stack.push(ref);
    return () => {
      const i = stack.lastIndexOf(ref);
      if (i >= 0) stack.splice(i, 1);
      if (!stack.length) window.removeEventListener("keydown", onKey);
    };
  }, [active]);
}
