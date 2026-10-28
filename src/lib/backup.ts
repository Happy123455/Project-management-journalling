import { unzipSync, zipSync } from "fflate";

export interface BackupEntry {
  /** Path inside the zip, e.g. "journal.db" or "attachments/<id>/photo.jpg". */
  name: string;
  bytes: Uint8Array;
}

const NAME_RE = /^dynamic-journal-(\d{4}-\d{2}-\d{2})\.zip$/;

/** "dynamic-journal-2026-10-28.zip" for a local day key. */
export const backupFileName = (day: string) => `dynamic-journal-${day}.zip`;

/** Daily backups beyond the newest `keep`, oldest first; other files in the folder are left alone. */
export function backupsToDelete(names: string[], keep = 14): string[] {
  const backups = names.filter((n) => NAME_RE.test(n)).sort();
  return backups.slice(0, Math.max(0, backups.length - keep));
}

/** Packs the journal and its attachments into one zip. Photos and videos are already compressed, so they are stored as is. */
export function zipBackup(entries: BackupEntry[]): Uint8Array {
  const files: Record<string, [Uint8Array, { level: 0 | 6 }]> = {};
  for (const e of entries) files[e.name] = [e.bytes, { level: e.name.startsWith("attachments/") ? 0 : 6 }];
  return zipSync(files);
}

export function unzipBackup(zip: Uint8Array): BackupEntry[] {
  return Object.entries(unzipSync(zip)).map(([name, bytes]) => ({ name, bytes }));
}

export interface BackupSummary {
  /** "sqlite" from the app, "json" from the browser preview. */
  format: "sqlite" | "json";
  attachments: number;
  /** The day in the zip's name, when it has the usual name. */
  day: string | null;
}

const SQLITE_MAGIC = "SQLite format 3\0";

/** What a backup zip holds, or a reason it can't be restored. */
export function inspectBackup(entries: BackupEntry[], fileName = ""): BackupSummary | { error: string } {
  const db = entries.find((e) => e.name === "journal.db");
  const json = entries.find((e) => e.name === "journal.json");
  const attachments = entries.filter((e) => e.name.startsWith("attachments/") && !e.name.endsWith("/")).length;
  const day = fileName.match(NAME_RE)?.[1] ?? null;
  if (db) {
    const head = new TextDecoder().decode(db.bytes.slice(0, 16));
    if (head !== SQLITE_MAGIC) return { error: "The journal file in this zip is damaged." };
    return { format: "sqlite", attachments, day };
  }
  if (json) {
    try {
      const data = JSON.parse(new TextDecoder().decode(json.bytes));
      if (!data || typeof data.pages !== "object") throw new Error();
    } catch {
      return { error: "The journal file in this zip is damaged." };
    }
    return { format: "json", attachments, day };
  }
  return { error: "This zip isn't a Dynamic Journal backup." };
}
