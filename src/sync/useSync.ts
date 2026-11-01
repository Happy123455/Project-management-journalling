import { useCallback, useEffect, useRef, useState } from "react";
import { coalesce } from "../lib/coalesce";
import type { JournalStore } from "../store";
import { syncOnce, type SyncMemory } from "./engine";
import { repairMergeLosses } from "../lib/repairMerge";
import { showToast } from "../lib/toast";
import { findSyncFolder, pickSyncFolder, type FolderLookup } from "./folders";
import { BEAT_MS, LIVE_POLL_MS, LIVE_SAVE_MS, openHost, othersRev, readPresence, someoneOpen, writePresence, type Presence } from "./live";
import { canConnect, canHost, startClient, startHost, type Client, type DirectAddress, type Host } from "./direct";

/** What sync remembers between rounds (what it sent and read), so it only moves what's new. */
const localMemory: SyncMemory = {
  get: (key) => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set: (key, value) => {
    try {
      localStorage.setItem(key, value);
    } catch {
      // Full or blocked: the next round just checks the folder again.
    }
  },
};

const EVERY_MS = 3 * 60 * 1000;
const AFTER_SAVE_MS = 15 * 1000;

export type SyncStatus =
  | { state: "off"; reason: string }
  | { state: "needs-folder" }
  | { state: "syncing"; label: string; last: Date | null }
  | { state: "ok"; label: string; last: Date }
  | { state: "error"; label: string; last: Date | null; message: string };

/**
 * Keeps this device in sync through the Google Drive folder: on start, on coming back to the
 * app, every few minutes, and shortly after saves. `onImported` runs when other devices' changes arrived.
 */
export function useSync(store: JournalStore | null, onImported: () => void) {
  const [status, setStatus] = useState<SyncStatus>({ state: "off", reason: "Starting…" });
  /** Both apps open: changes go across within seconds (see live.ts). */
  const [live, setLive] = useState(false);
  const liveRef = useRef(false);
  /** Connected straight over Wi-Fi (see direct.ts): edits go across in about a second. */
  const [direct, setDirect] = useState(false);
  const directRef = useRef(false);
  const host = useRef<Host | null>(null);
  const client = useRef<Client | null>(null);
  const lan = useRef<DirectAddress | null>(null);
  const myRev = useRef(String(Date.now()));
  const folderCache = useRef<{ found: Extract<FolderLookup, { kind: "ready" }>; at: number } | null>(null);
  const last = useRef<Date | null>(null);
  const afterSave = useRef<number | undefined>(undefined);
  const repaired = useRef(false);
  const imported = useRef(onImported);
  imported.current = onImported;

  const run = useCallback(
    () =>
      coalesce(async () => {
        if (!store) return;
        const found = await findSyncFolder(store.deviceId);
        if (found.kind === "pick") return setStatus({ state: "needs-folder" });
        if (found.kind === "unavailable") return setStatus({ state: "off", reason: found.reason });
        folderCache.current = { found, at: Date.now() };
        setStatus({ state: "syncing", label: found.label, last: last.current });
        try {
          const result = await syncOnce(store, found.folder, localMemory);
          // New edits went out: tell an open app on the other device to fetch them now.
          if (result.exported) {
            myRev.current = String(Date.now());
            void writePresence(found.folder, store.deviceId, { at: Date.now(), rev: myRev.current, lan: lan.current ?? undefined }).catch(() => {});
          }
          last.current = new Date();
          setStatus({ state: "ok", label: found.label, last: last.current });
          if (result.files) window.dispatchEvent(new Event("journal:files-arrived"));
          if (result.imported || result.files) imported.current();
          // Once per launch, after the first round (so this device has both sides' history): put
          // back link cards and media the old merge dropped. Never while typing.
          const typing = !!document.activeElement?.closest?.(".tiptap, .source-text");
          if (!repaired.current && !typing) {
            repaired.current = true;
            await window.__journalFlush?.();
            const back = await repairMergeLosses(store).catch(() => 0);
            if (back) {
              showToast(`Brought back ${back} ${back === 1 ? "link or photo" : "links and photos"} an earlier sync had dropped`);
              imported.current();
            }
          }
        } catch (e) {
          setStatus({ state: "error", label: found.label, last: last.current, message: e instanceof Error ? e.message : String(e) });
        }
      }),
    [store],
  );
  const syncNow = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    syncNow.current = run();
  }, [run]);

  useEffect(() => {
    if (!store) return;
    void syncNow.current();
    const timer = window.setInterval(() => void syncNow.current(), EVERY_MS);
    // Coming back to the app: sync once things have settled, not in the same moment the page is
    // redrawn (that stalled the first touches after returning from YouTube or another app).
    let back: number | undefined;
    const onVisible = () => {
      window.clearTimeout(back);
      if (document.visibilityState === "visible") back = window.setTimeout(() => void syncNow.current(), 2500);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearTimeout(back);
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [store]);

  // Live mode: say this app is open, watch for the other device's app, and while both are open
  // look for its changes every couple of seconds.
  useEffect(() => {
    if (!store) return;
    const me = store.deviceId;
    const known = new Map<string, { stamp: string; p: Presence | null }>();
    let lastRev: string | null = null;
    let stopped = false;
    let timer: number | undefined;
    let lastBeat = 0;
    const folder = async () => {
      const c = folderCache.current;
      if (c && Date.now() - c.at < 5 * 60_000) return c.found.folder;
      const found = await findSyncFolder(me);
      if (found.kind !== "ready") return null;
      folderCache.current = { found, at: Date.now() };
      return found.folder;
    };
    const showDirect = (v: boolean) => {
      if (v === directRef.current) return;
      directRef.current = v;
      setDirect(v);
    };
    // Mac: take the phone's direct connections.
    if (canHost())
      void startHost(store, () => imported.current()).then(
        (h) => (stopped ? h.stop() : (host.current = h)),
        () => {},
      );
    const tick = async () => {
      if (stopped) return;
      const visible = document.visibilityState === "visible";
      try {
        const f = visible ? await folder() : null;
        if (f) {
          if (Date.now() - lastBeat > BEAT_MS) {
            lastBeat = Date.now();
            // The Mac's Wi-Fi address can change (another network); look it up with each beat.
            if (host.current) lan.current = await host.current.address();
            await writePresence(f, me, { at: Date.now(), rev: myRev.current, lan: lan.current ?? undefined });
          }
          await readPresence(f, me, known);
          if (host.current) showDirect(Date.now() - host.current.lastSeen() < 35_000);
          // Phone: connect straight to the Mac while its app is open.
          if (canConnect()) {
            const at = openHost(known);
            const same = at && client.current && JSON.stringify(client.current.address) === JSON.stringify(at);
            if (!same) {
              client.current?.stop();
              client.current = at
                ? startClient(store, at, () => imported.current(), (up) => {
                    showDirect(up);
                    if (up) void syncNow.current(); // catch up on what happened before the link
                  })
                : null;
            }
          }
          const open = someoneOpen(known);
          if (open !== liveRef.current) {
            liveRef.current = open;
            setLive(open);
          }
          const rev = othersRev(known);
          if (lastRev !== null && rev !== lastRev && open) void syncNow.current();
          lastRev = rev;
        }
      } catch {
        folderCache.current = null; // e.g. the Drive sign-in expired: look the folder up again
      }
      // Connected directly: Drive is only the backup, so it needn't be watched closely.
      if (!stopped) timer = window.setTimeout(tick, liveRef.current && !directRef.current ? LIVE_POLL_MS : 15_000);
    };
    timer = window.setTimeout(tick, 4000);
    // Going to the background or closing: tell the other device right away.
    const bye = () => {
      const f = folderCache.current?.found.folder;
      if (f) void writePresence(f, me, { at: Date.now(), rev: myRev.current, closed: true }).catch(() => {});
      lastBeat = 0;
      // Phone in the background: drop the link (it comes back on return).
      client.current?.stop();
      client.current = null;
    };
    const onVisible = () => {
      if (document.visibilityState === "hidden") bye();
      else {
        window.clearTimeout(timer);
        timer = window.setTimeout(tick, 500);
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pagehide", bye);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      client.current?.stop();
      client.current = null;
      host.current?.stop();
      host.current = null;
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pagehide", bye);
    };
  }, [store]);

  /** Call after a save; syncs once things have been quiet for a moment (right away in live mode). */
  const afterSaved = useCallback(() => {
    window.clearTimeout(afterSave.current);
    client.current?.notify();
    host.current?.notify();
    // Connected directly the edit is already across; Drive gets it a little later as the backup.
    const delay = directRef.current ? AFTER_SAVE_MS : liveRef.current ? LIVE_SAVE_MS : AFTER_SAVE_MS;
    afterSave.current = window.setTimeout(() => void syncNow.current(), delay);
  }, []);

  const chooseFolder = useCallback(async () => {
    if (await pickSyncFolder()) await syncNow.current();
  }, []);

  return { status, live, direct, syncNow: () => syncNow.current(), afterSaved, chooseFolder };
}
