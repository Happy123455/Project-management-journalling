import { useEffect, useState } from "react";
import type { SyncStatus as Status } from "./useSync";
import type { StorageUsage } from "./engine";
import { syncStorage } from "./folders";
import { visibleInterval } from "../lib/power";
import { ANOMALY_EVENT, anomalies, anomalyText, clearAnomalies, stamp, type AnomalyKind, type Path } from "./anomalies";
import { bytes, clearTransfers, TRANSFER_EVENT, transfers, type Via } from "./transferLog";
import type { ConnectResult } from "./direct";
import { clipShareOn, setClipShare } from "./clipboard";
import { showToast } from "../lib/toast";

const inApp = () => "__TAURI_INTERNALS__" in window;
const onPhone = () => /Android/i.test(navigator.userAgent);

/**
 * ⚡ Connect: look for the other device's open app on this Wi-Fi and link straight to it now
 * (the automatic link keeps working too). Closing or leaving either app goes back to Drive.
 */
function ConnectButton({ direct, onConnect }: { direct?: boolean; onConnect: () => Promise<ConnectResult> }) {
  const [busy, setBusy] = useState(false);
  const other = onPhone() ? "Mac" : "phone";
  const press = async () => {
    if (busy) return;
    setBusy(true);
    window.JournalHaptics?.play("press", 0.6);
    try {
      const r = await onConnect();
      if (r === "linked") {
        window.JournalHaptics?.play("edge", 0.8);
        showToast(`⚡ Connected to your ${other}: edits, photos and copies go across instantly`);
      } else if (r === "no-wifi") showToast("⚡ Not on a Wi-Fi network: syncing through Google Drive", "error");
      else if (r === "no-key")
        showToast("⚡ This phone hasn't met your Mac yet: open the journal on both with Drive sync on for a minute, then try again", "error");
      else showToast(`⚡ Couldn't find the journal open on your ${other} on this Wi-Fi: syncing through Google Drive`, "error");
    } catch (e) {
      showToast(`⚡ Couldn't connect: ${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <button type="button" className={`sync-connect${direct ? " on" : ""}${busy ? " busy" : ""}`} onClick={() => void press()} disabled={busy}>
      {busy ? `Looking for your ${other}…` : direct ? `⚡ Connected · check again` : `⚡ Connect to ${other}`}
    </button>
  );
}

/** 📋 Shared clipboard on/off (only does anything while connected). */
function ClipToggle() {
  const [on, setOn] = useState(clipShareOn);
  return (
    <label className="sync-clip">
      <input
        type="checkbox"
        checked={on}
        onChange={(e) => {
          setClipShare(e.target.checked);
          setOn(e.target.checked);
        }}
      />
      📋 Shared clipboard while connected
    </label>
  );
}

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

/** ▾ Network history: what went across lately, over the Wi-Fi link and through Google Drive. */
function TransferHistory() {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState(transfers);
  useEffect(() => {
    if (!open) return;
    const on = () => setList(transfers());
    on();
    window.addEventListener(TRANSFER_EVENT, on);
    return () => window.removeEventListener(TRANSFER_EVENT, on);
  }, [open]);
  const day = Date.now() - 86_400_000;
  const today = list.filter((t) => t.at > day);
  const sum = (via: Via) => today.filter((t) => t.via === via).reduce((n, t) => n + t.up + t.down, 0);
  return (
    <div className={`sync-history${open ? " open" : ""}`}>
      <button type="button" className="sync-history-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? "▴" : "▾"} Network history
      </button>
      {open && (
        <div className="sync-history-body">
          <p className="sync-history-sum">
            Last 24 h: 📶 Wi-Fi {bytes(sum("wifi"))} · ☁︎ Drive {bytes(sum("drive"))} · 📱 mobile data {bytes(sum("mobile"))}
          </p>
          {list.length ? (
            <ul>
              {list.map((t, i) => (
                <li key={`${t.at}-${i}`}>
                  <span className="sync-history-via">{t.via === "wifi" ? "📶" : t.via === "mobile" ? "📱" : "☁︎"}</span>
                  <span className="sync-history-when">{new Date(t.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                  <span className="sync-history-what">{t.what}{t.n > 1 ? ` ×${t.n}` : ""}</span>
                  <span className="sync-history-size">↑{bytes(t.up)} ↓{bytes(t.down)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="hint">Nothing sent or received yet on this device.</p>
          )}
          {list.length > 0 && <button type="button" onClick={() => (clearTransfers(), setList([]))}>Clear</button>}
        </div>
      )}
    </div>
  );
}

const KIND_ICON: Record<AnomalyKind, string> = {
  clash: "⚡",
  joined: "🔗",
  "kept-edited": "🛟",
  "lines-removed": "✂︎",
  "out-of-order": "⇅",
  "clock-ahead": "⏱",
  unreadable: "⚠︎",
  "stale-save": "💾",
  resolved: "✓",
};
const PATH_LABEL: Record<Path, string> = { wifi: "Wi-Fi", cloud: "Cloud", "wifi-typing": "Wi-Fi typing", save: "Save", local: "Here" };

/** ▾ Sync log: clashes and anything odd sync noticed, with millisecond times (sync/anomalies.ts). */
function AnomalyLog() {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState(anomalies);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!open) return;
    const on = () => setList([...anomalies()]);
    on();
    window.addEventListener(ANOMALY_EVENT, on);
    return () => window.removeEventListener(ANOMALY_EVENT, on);
  }, [open]);
  const clashes = list.filter((a) => a.kind === "clash").length;
  return (
    <div className={`sync-history${open ? " open" : ""}`}>
      <button type="button" className="sync-history-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? "▴" : "▾"} Sync log{list.length ? ` (${list.length}${clashes ? `, ${clashes} clash${clashes === 1 ? "" : "es"}` : ""})` : ""}
      </button>
      {open && (
        <div className="sync-history-body">
          {list.length ? (
            <ul className="sync-anomalies">
              {list.map((a, i) => (
                <li key={`${a.at}-${i}`} title={a.detail ? JSON.stringify(a.detail, null, 1) : undefined}>
                  <span className="sync-history-via">{KIND_ICON[a.kind] ?? "•"}</span>
                  <span className="sync-history-when">{stamp(a.at).slice(7)}</span>
                  <span className="sync-history-what">
                    <b>{PATH_LABEL[a.path] ?? a.path}</b> {a.note ? `${a.note.replace(/^(day|page):/, "")} · ` : ""}
                    {a.text}
                    {a.detail?.lagMs !== undefined ? ` · ${a.detail.lagMs} ms after it was made` : ""}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="hint">Nothing odd yet. Clashes, lines the other device removed, late or unreadable edits show up here with times to the millisecond.</p>
          )}
          {list.length > 0 && (
            <>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard?.writeText(anomalyText()).then(() => setCopied(true), () => {});
                }}
              >
                {copied ? "Copied" : "Copy log"}
              </button>{" "}
              <button type="button" onClick={() => (clearAnomalies(), setList([]))}>Clear</button>
            </>
          )}
        </div>
      )}
    </div>
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
export function SyncStatus({ status, live, direct, onSync, onChooseFolder, onConnect }: {
  status: Status;
  live?: boolean;
  direct?: boolean;
  onSync: () => void;
  onChooseFolder: () => void;
  onConnect?: () => Promise<ConnectResult>;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    return visibleInterval(() => setNow(Date.now()), 30_000);
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
      {direct ? (
        <span className="sync-live" title="Connected straight over Wi-Fi: edits, photos and copies go across at once (Drive still keeps a copy)">⚡ Instant with your other device (Wi-Fi)</span>
      ) : (
        live && <span className="sync-live" title="The app is open on your other device too: changes go across within seconds">⚡ Live with your other device</span>
      )}
      {onConnect && inApp() && <ConnectButton direct={direct} onConnect={onConnect} />}
      {inApp() && <ClipToggle />}
      <button type="button" onClick={onSync} disabled={status.state === "syncing"}>Sync now</button>
      <StorageLine />
      <TransferHistory />
      <AnomalyLog />
      {status.state === "error" && window.JournalSync && (
        <button type="button" onClick={onChooseFolder}>☁︎ Sign in again…</button>
      )}
    </div>
  );
}

/**
 * The menu's one-line sync status: tap it for Nexus (sync details, Connect, Send, this note's
 * history). Red when sync failed, ⚡ while linked straight over Wi-Fi.
 */
export function SyncChip({ status, live, direct, onOpen }: { status: Status; live?: boolean; direct?: boolean; onOpen: () => void }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => visibleInterval(() => setNow(Date.now()), 30_000), []);
  const line =
    status.state === "needs-folder"
      ? "Sync not set up · tap to start"
      : status.state === "off"
        ? `Sync off · ${status.reason}`
        : status.state === "syncing"
          ? "Syncing…"
          : status.state === "error"
            ? `Sync failed · tap to fix`
            : `Synced ${ago(status.last, now)}`;
  return (
    <button type="button" className={`sync-chip ${status.state}${direct ? " direct" : ""}`} onClick={onOpen} title="Open Nexus: sync, send to your other device, history">
      <span className="sync-chip-dot" aria-hidden />
      <span className="sync-chip-line">☁︎ {line}</span>
      {direct ? <span className="sync-chip-link">⚡ Wi-Fi</span> : live ? <span className="sync-chip-link">⚡ Live</span> : null}
      <span className="sync-chip-go" aria-hidden>⑂ ›</span>
    </button>
  );
}
