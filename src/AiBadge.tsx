import { useEffect, useState, useSyncExternalStore } from "react";
import { currentJob, subscribeJob } from "./ai/chatRunner";

/** A small 🤖 pill while an AI chat reply runs in the background; tap it to open that chat. */
export function AiBadge() {
  const job = useSyncExternalStore(subscribeJob, currentJob);
  const [now, setNow] = useState(Date.now());
  const restUntil = job?.progress?.restUntil ?? 0;
  useEffect(() => {
    if (!restUntil) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [restUntil]);
  if (!job) return null;
  const p = job.progress;
  const label = job.remote ? "💻 Mac" : !p ? "…" : restUntil > now ? `${p.hot ? "🌡️" : "❄️"} ${Math.ceil((restUntil - now) / 1000)}s` : p.answer ? "writing" : "thinking";
  return (
    <button type="button" className="ai-badge" title={`AI is answering “${job.title}”`} onClick={() => window.dispatchEvent(new CustomEvent("journal:open-ai-chat", { detail: job.chatId }))}>
      <span className="ai-badge-dot" />🤖 {label}
    </button>
  );
}
