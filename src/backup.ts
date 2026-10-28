import { backupFileName, backupsToDelete, inspectBackup, unzipBackup, zipBackup, type BackupSummary } from "./lib/backup";
import { dayKey } from "./lib/timestamp";
import type { JournalStore } from "./store";

const inTauri = () => "__TAURI_INTERNALS__" in window;
const onDesktop = () => inTauri() && !/Android|iPhone|iPad/i.test(navigator.userAgent);

const AUTO_DIR = "Dynamic Journal Backups";
const KEEP_DAILY = 14;

/** One-tap export: zips the whole journal and lets the user pick where to save it. Returns where it went, or null if cancelled. */
export async function exportBackup(store: JournalStore): Promise<string | null> {
  const zip = zipBackup(await store.exportFiles());
  const name = backupFileName(dayKey(new Date()));
  if (!inTauri()) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([zip as BlobPart], { type: "application/zip" }));
    a.download = name;
    a.click();
    return name;
  }
  const [{ save }, { writeFile }] = await Promise.all([import("@tauri-apps/plugin-dialog"), import("@tauri-apps/plugin-fs")]);
  const path = await save({ defaultPath: name, filters: [{ name: "Journal backup", extensions: ["zip"] }] });
  if (!path) return null;
  await writeFile(path, zip);
  return path;
}

/**
 * On the Mac, once a day: writes Documents/Dynamic Journal Backups/dynamic-journal-<day>.zip
 * and keeps the newest two weeks. Returns true when a backup was written.
 */
export async function autoBackup(store: JournalStore): Promise<boolean> {
  if (!onDesktop()) return false;
  const fs = await import("@tauri-apps/plugin-fs");
  const opts = { baseDir: fs.BaseDirectory.Document };
  const file = `${AUTO_DIR}/${backupFileName(dayKey(new Date()))}`;
  if (await fs.exists(file, opts)) return false;
  await fs.mkdir(AUTO_DIR, { ...opts, recursive: true });
  await fs.writeFile(file, zipBackup(await store.exportFiles()), opts);
  const names = (await fs.readDir(AUTO_DIR, opts)).map((e) => e.name);
  for (const old of backupsToDelete(names, KEEP_DAILY)) await fs.remove(`${AUTO_DIR}/${old}`, opts);
  return true;
}

/** A chosen backup zip, read and checked, ready to restore. */
export interface PendingRestore {
  name: string;
  entries: { name: string; bytes: Uint8Array }[];
  summary: BackupSummary;
}

/** Reads and checks a picked zip; throws with a readable reason when it can't be restored. */
export async function readBackup(file: File): Promise<PendingRestore> {
  const entries = unzipBackup(new Uint8Array(await file.arrayBuffer()));
  const summary = inspectBackup(entries, file.name);
  if ("error" in summary) throw new Error(summary.error);
  if (summary.format === "json" && inTauri()) throw new Error("This backup comes from the browser preview, not the app.");
  if (summary.format === "sqlite" && !inTauri()) throw new Error("This backup comes from the app; restore it there.");
  return { name: file.name, entries, summary };
}

/**
 * Restores a checked backup. In the app, the current journal is first saved to
 * backups/before-restore-<time>.zip in the app's data folder, so nothing is lost.
 */
export async function restoreBackup(store: JournalStore, pending: PendingRestore): Promise<void> {
  if (inTauri()) {
    const fs = await import("@tauri-apps/plugin-fs");
    const base = { baseDir: fs.BaseDirectory.AppData };
    await fs.mkdir("backups", { ...base, recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await fs.writeFile(`backups/before-restore-${stamp}.zip`, zipBackup(await store.exportFiles()), base);
  }
  await store.restore(pending.entries, pending.name);
}
