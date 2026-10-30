import { useCallback, useEffect, useRef, useState } from "react";
import { coalesce } from "../lib/coalesce";
import type { JournalStore } from "../store";
import { syncOnce } from "./engine";
import { findSyncFolder, pickSyncFolder } from "./folders";

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
  const last = useRef<Date | null>(null);
  const afterSave = useRef<number | undefined>(undefined);
  const imported = useRef(onImported);
  imported.current = onImported;

  const run = useCallback(
    () =>
      coalesce(async () => {
        if (!store) return;
        const found = await findSyncFolder();
        if (found.kind === "pick") return setStatus({ state: "needs-folder" });
        if (found.kind === "unavailable") return setStatus({ state: "off", reason: found.reason });
        setStatus({ state: "syncing", label: found.label, last: last.current });
        try {
          const result = await syncOnce(store, found.folder);
          last.current = new Date();
          setStatus({ state: "ok", label: found.label, last: last.current });
          if (result.imported || result.files) imported.current();
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

  /** Call after a save; syncs once things have been quiet for a moment. */
  const afterSaved = useCallback(() => {
    window.clearTimeout(afterSave.current);
    afterSave.current = window.setTimeout(() => void syncNow.current(), AFTER_SAVE_MS);
  }, []);

  const chooseFolder = useCallback(async () => {
    if (await pickSyncFolder()) await syncNow.current();
  }, []);

  return { status, syncNow: () => syncNow.current(), afterSaved, chooseFolder };
}
