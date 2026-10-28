import { useEffect, useState } from "react";
import { dismissToast, subscribeToasts, type Toast } from "./lib/toast";

/** Floating glass messages at the top of the screen, over the page. */
export function Toasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  useEffect(() => subscribeToasts(setToasts), []);
  if (!toasts.length) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          <span className="toast-text">{t.kind === "error" ? "⚠️ " : ""}{t.message}</span>
          <button type="button" onClick={() => dismissToast(t.id)} aria-label="Close message">✕</button>
        </div>
      ))}
    </div>
  );
}
