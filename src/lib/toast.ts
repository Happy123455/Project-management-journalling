export interface Toast {
  id: number;
  message: string;
  kind: "error" | "info";
  /** A button on the message (Undo); pressing it closes the message. */
  action?: { label: string; run: () => void };
}

export interface ToastOptions {
  /**
   * Something that happened by itself (sync, a copy from the other device, a file arriving, an AI
   * answer): while you're typing it waits, and shows once you stop, so it never covers the line
   * you're writing or the keyboard.
   */
  background?: boolean;
}

type Listener = (toasts: Toast[]) => void;

const AUTO_HIDE_MS = { error: 7000, info: 3500 };
/** Typing counts as stopped this long after the last key. */
const TYPING_PAUSE_MS = 2500;
/** Waiting messages kept while typing (the newest). */
const MAX_WAITING = 5;
/** A waiting message older than this is dropped (it would be news from long ago). */
const MAX_WAIT_MS = 15 * 60_000;

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<Listener>();
const emit = () => listeners.forEach((l) => l(toasts));

function show(message: string, kind: Toast["kind"], action: Toast["action"] | undefined, id = nextId++): number {
  // The same message again just restarts its timer instead of stacking up.
  toasts = toasts.filter((t) => t.message !== message);
  const toast: Toast = { id, message, kind, action };
  toasts = [...toasts, toast].slice(-3);
  emit();
  setTimeout(() => dismissToast(toast.id), action ? 6000 : AUTO_HIDE_MS[kind]);
  return toast.id;
}

// ── While typing ──

let lastKeyAt = 0;
let watching = false;
const waiting: { id: number; message: string; kind: Toast["kind"]; action?: Toast["action"]; at: number }[] = [];
let recheck: ReturnType<typeof setTimeout> | null = null;

const EDITABLE = ".tiptap, .source-text, input, textarea, select, [contenteditable='true']";

/** The phone's keyboard is up (the visible part of the screen is much shorter than the screen). */
function keyboardUp(): boolean {
  if (typeof window === "undefined") return false;
  const vv = window.visualViewport;
  return !!window.screen && window.screen.height - (vv?.height ?? window.innerHeight) > 250 && !!document.activeElement?.closest?.(EDITABLE);
}

/** You're writing: a key in the last moments, or a field focused with the keyboard up. */
export function isTyping(now = Date.now()): boolean {
  if (typeof document === "undefined") return false;
  const inField = !!document.activeElement?.closest?.(EDITABLE);
  return (inField && now - lastKeyAt < TYPING_PAUSE_MS) || keyboardUp();
}

function watchTyping() {
  if (watching || typeof document === "undefined") return;
  watching = true;
  const typed = () => (lastKeyAt = Date.now());
  document.addEventListener("keydown", typed, true);
  document.addEventListener("beforeinput", typed, true);
  // Leaving the field or the keyboard closing: show what waited, a moment later.
  const soon = () => scheduleFlush(400);
  document.addEventListener("focusout", soon, true);
  window.visualViewport?.addEventListener("resize", soon);
}

function scheduleFlush(ms: number) {
  if (!waiting.length) return;
  if (recheck) clearTimeout(recheck);
  recheck = setTimeout(flushWaiting, ms);
}

function flushWaiting() {
  recheck = null;
  if (!waiting.length) return;
  const now = Date.now();
  // Still typing: look again in a little while (a timer only while something is waiting).
  if (isTyping(now)) return scheduleFlush(TYPING_PAUSE_MS);
  const due = waiting.splice(0).filter((w) => now - w.at < MAX_WAIT_MS);
  for (const w of due) show(w.message, w.kind, w.action, w.id);
}

/** Messages waiting for typing to stop (for tests and the status line). */
export const waitingToasts = () => waiting.map((w) => w.message);

/**
 * Shows a floating message over the page (never pushes the layout); it hides itself after a few
 * seconds. With `{ background: true }` it waits while you're typing.
 */
export function showToast(message: string, kind: Toast["kind"] = "info", action?: Toast["action"], options?: ToastOptions): number {
  if (options?.background) {
    watchTyping();
    if (isTyping()) {
      const id = nextId++;
      const same = waiting.findIndex((w) => w.message === message);
      if (same >= 0) waiting.splice(same, 1);
      waiting.push({ id, message, kind, action, at: Date.now() });
      if (waiting.length > MAX_WAITING) waiting.splice(0, waiting.length - MAX_WAITING);
      scheduleFlush(TYPING_PAUSE_MS);
      return id;
    }
  }
  return show(message, kind, action);
}

/** A message about something that happened by itself: waits while you're typing. */
export const showBackgroundToast = (message: string, kind: Toast["kind"] = "info", action?: Toast["action"]) =>
  showToast(message, kind, action, { background: true });

export const showError = (what: string, error: unknown) => {
  console.error(what, error);
  return showToast(`${what}: ${error instanceof Error ? error.message : String(error)}`, "error");
};

export function dismissToast(id: number) {
  const queued = waiting.findIndex((w) => w.id === id);
  if (queued >= 0) waiting.splice(queued, 1);
  const before = toasts.length;
  toasts = toasts.filter((t) => t.id !== id);
  if (toasts.length !== before) emit();
}

export function subscribeToasts(listener: Listener): () => void {
  listeners.add(listener);
  listener(toasts);
  return () => listeners.delete(listener);
}
