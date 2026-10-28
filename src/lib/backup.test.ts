import { describe, expect, it } from "vitest";
import { backupFileName, backupsToDelete, unzipBackup, zipBackup } from "./backup";

describe("backups", () => {
  it("names a day's backup", () => {
    expect(backupFileName("2026-10-28")).toBe("dynamic-journal-2026-10-28.zip");
  });

  it("keeps the newest backups and ignores other files", () => {
    const names = ["dynamic-journal-2026-10-01.zip", "notes.txt", "dynamic-journal-2026-10-03.zip", "dynamic-journal-2026-10-02.zip"];
    expect(backupsToDelete(names, 2)).toEqual(["dynamic-journal-2026-10-01.zip"]);
    expect(backupsToDelete(names, 5)).toEqual([]);
  });

  it("round-trips the journal and attachments through a zip", () => {
    const entries = [
      { name: "journal.db", bytes: new TextEncoder().encode("db bytes") },
      { name: "attachments/a1/photo.jpg", bytes: new Uint8Array([255, 216, 1, 2]) },
    ];
    expect(unzipBackup(zipBackup(entries))).toEqual(entries);
  });
});
