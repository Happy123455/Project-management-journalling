import { useEffect, useState } from "react";
import type { SyncStatus as Status } from "./useSync";

function ago(date: Date, now: number): string {
  const s = Math.round((now - date.getTime()) / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : date.toLocaleDateString();
}

/** "☁︎ Synced 2 min ago" with a Sync now button, or what's needed to start syncing. */
export function SyncStatus({ status, onSync, onChooseFolder }: { status: Status; onSync: () => void; onChooseFolder: () => void }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, []);

  if (status.state === "needs-folder") {
    return (
      <div className="sync-status">
        <p className="hint">Sync with your Mac through Google Drive: choose (or create) the “Dynamic Journal Sync” folder in Drive once.</p>
        <button type="button" onClick={onChooseFolder}>☁︎ Choose Google Drive folder…</button>
      </div>
    );
  }
  if (status.state === "off") {
    return (
      <div className="sync-status">
        <span className="sync-line">☁︎ Sync off · {status.reason}</span>
      </div>
    );
  }
  const line =
    status.state === "syncing" ? "Syncing…" : status.state === "error" ? `Sync failed: ${status.message}` : `Synced ${ago(status.last, now)}`;
  return (
    <div className={`sync-status ${status.state}`}>
      <span className="sync-line" title={status.label}>☁︎ {line}</span>
      <button type="button" onClick={onSync} disabled={status.state === "syncing"}>Sync now</button>
    </div>
  );
}
