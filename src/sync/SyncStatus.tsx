import { useEffect, useState } from "react";
import type { SyncStatus as Status } from "./useSync";
import type { StorageUsage } from "./engine";
import { syncStorage } from "./folders";

const size = (bytes: number) =>
  bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.round(bytes / 1e3)} KB`;

/** "Storage": the sync folder's size, and the Google account's used / limit where the app can ask Drive. */
function StorageLine() {
  const [usage, setUsage] = useState<StorageUsage | null | "loading" | string>(null);
  if (usage === null)
    return (
      <button type="button" onClick={() => {
        setUsage("loading");
        syncStorage().then((u) => setUsage(u ?? "Not available here"), (e) => setUsage(String(e?.message ?? e)));
      }}>Drive storage</button>
    );
  if (typeof usage === "string") return <span className="sync-line">{usage === "loading" ? "Checking Drive storage…" : usage}</span>;
  const a = usage.account;
  return (
    <span className="sync-line">
      Journal sync folder: {size(usage.folderBytes)} in {usage.files} files
      {a ? ` · Google storage: ${size(a.usage)} used of ${a.limit ? size(a.limit) : "unlimited"} (Drive ${size(a.drive)})` : " · open this on the phone to see the account's limit"}
    </span>
  );
}

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
        <p className="hint">Sync with your Mac through Google Drive: sign in once with the Google account your Mac’s Drive uses. Notes go to My Drive › Dynamic Journal Sync.</p>
        <button type="button" onClick={onChooseFolder}>☁︎ Sign in to Google Drive…</button>
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
      <StorageLine />
      {status.state === "error" && window.JournalSync && (
        <button type="button" onClick={onChooseFolder}>☁︎ Sign in again…</button>
      )}
    </div>
  );
}
