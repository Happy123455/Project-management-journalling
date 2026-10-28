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
