import { describe, expect, it } from "vitest";
import { backupFileName, backupsToDelete, inspectBackup, unzipBackup, zipBackup } from "./backup";

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

  it("recognises app and browser backups and rejects other zips", () => {
    const enc = (t: string) => new TextEncoder().encode(t);
    const db = { name: "journal.db", bytes: enc("SQLite format 3\0rest of file") };
    const photo = { name: "attachments/a/p.jpg", bytes: new Uint8Array([1]) };
    expect(inspectBackup([db, photo], "dynamic-journal-2026-10-28.zip")).toEqual({ format: "sqlite", attachments: 1, day: "2026-10-28" });
    expect(inspectBackup([{ name: "journal.json", bytes: enc('{"pages":{}}') }])).toEqual({ format: "json", attachments: 0, day: null });
    expect(inspectBackup([{ name: "journal.db", bytes: enc("not a database!!") }])).toEqual({ error: "The journal file in this zip is damaged." });
    expect(inspectBackup([{ name: "notes.txt", bytes: enc("hi") }])).toEqual({ error: "This zip isn't a Dynamic Journal backup." });
  });
});
