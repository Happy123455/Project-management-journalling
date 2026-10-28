import { useRef, useState } from "react";
import { readBackup, restoreBackup, type PendingRestore } from "../backup";
import { showError, showToast } from "../lib/toast";
import type { JournalStore } from "../store";

/** "Restore from backup…": pick a zip, see what's in it, confirm, restore, reload. */
export function RestoreButton({ store, onBeforeRestore }: { store: JournalStore | null; onBeforeRestore: () => Promise<void> }) {
  const input = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<PendingRestore | null>(null);
  const [busy, setBusy] = useState(false);

  const pick = async (file: File | undefined) => {
    if (!file) return;
    try {
      setPending(await readBackup(file));
    } catch (e) {
      showError("Can't restore this file", e);
    }
  };

  const confirm = async () => {
    if (!store || !pending) return;
    setBusy(true);
    try {
      await onBeforeRestore();
      await restoreBackup(store, pending);
      showToast("Journal restored");
      // Start fresh so every view shows the restored journal.
      window.setTimeout(() => window.location.reload(), 600);
    } catch (e) {
      showError("Restore failed", e);
      setBusy(false);
      setPending(null);
    }
  };

  return (
    <>
      <button type="button" className="restore-button" onClick={() => input.current?.click()} disabled={!store}>
        ⤺ Restore from backup…
      </button>
      <input
        ref={input}
        type="file"
        accept=".zip,application/zip"
        hidden
        onChange={(e) => {
          void pick(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      {pending && (
        <>
          <div className="search-backdrop" onClick={() => !busy && setPending(null)} />
          <div className="confirm-card" role="alertdialog" aria-label="Restore backup">
            <h2>Restore this backup?</h2>
            <p>
              <strong>{pending.name}</strong>
              {pending.summary.day && <> · from {pending.summary.day}</>}
              {" · "}
              {pending.summary.attachments} attachment{pending.summary.attachments === 1 ? "" : "s"}
            </p>
            <p className="hint">
              Your whole journal will be replaced by this backup.{" "}
              {"__TAURI_INTERNALS__" in window
                ? "A copy of the journal as it is now is saved first, so it can be brought back."
                : "This can't be undone here."}
            </p>
            <div className="confirm-actions">
              <button type="button" onClick={() => setPending(null)} disabled={busy}>Cancel</button>
              <button type="button" className="danger" onClick={confirm} disabled={busy}>{busy ? "Restoring…" : "Restore"}</button>
            </div>
          </div>
        </>
      )}
    </>
  );
}
