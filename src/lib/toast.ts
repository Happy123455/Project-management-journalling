export interface Toast {
  id: number;
  message: string;
  kind: "error" | "info";
  /** A button on the message (Undo); pressing it closes the message. */
  action?: { label: string; run: () => void };
}

type Listener = (toasts: Toast[]) => void;

const AUTO_HIDE_MS = { error: 7000, info: 3500 };

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<Listener>();
const emit = () => listeners.forEach((l) => l(toasts));

/** Shows a floating message over the page (never pushes the layout); it hides itself after a few seconds. */
export function showToast(message: string, kind: Toast["kind"] = "info", action?: Toast["action"]): number {
  // The same message again just restarts its timer instead of stacking up.
  toasts = toasts.filter((t) => t.message !== message);
  const toast: Toast = { id: nextId++, message, kind, action };
  toasts = [...toasts, toast].slice(-3);
  emit();
  setTimeout(() => dismissToast(toast.id), action ? 6000 : AUTO_HIDE_MS[kind]);
  return toast.id;
}

export const showError = (what: string, error: unknown) => {
  console.error(what, error);
  return showToast(`${what}: ${error instanceof Error ? error.message : String(error)}`, "error");
};

export function dismissToast(id: number) {
  const before = toasts.length;
  toasts = toasts.filter((t) => t.id !== id);
  if (toasts.length !== before) emit();
}

export function subscribeToasts(listener: Listener): () => void {
  listeners.add(listener);
  listener(toasts);
  return () => listeners.delete(listener);
}
