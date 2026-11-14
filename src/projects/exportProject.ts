import type { JournalStore, NamedPage } from "../store";
import { listChats } from "../ai/chatRunner";
import { zipBackupAsync, type BackupEntry } from "../lib/backup";
import { buildProjectExport, exportMarkdown } from "../lib/projectExport";
import { dayKey } from "../lib/timestamp";

/** Media past this (biggest first) is listed but left out of the zip, so it stays easy to upload. */
const MEDIA_LIMIT = 300 * 1024 * 1024;

const safe = (s: string) => s.replace(/[\\/:*?"<>|\n\r\t]+/g, "-").replace(/\s+/g, " ").trim().slice(0, 80) || "project";

/**
 * 📦 Export for AI: a zip with project.json (everything, with the graph at the top so Canvas
 * and the mind map open it), project.md (the same, readable, to paste into any chat) and the
 * project's photos, videos and recordings. Returns where it went, or null if cancelled.
 */
export async function exportProjectForAi(store: JournalStore, page: NamedPage): Promise<string | null> {
  await window.__journalFlush?.();
  const data = await buildProjectExport(store, page, await listChats(store).catch(() => []));
  const files: BackupEntry[] = [];
  let total = 0;
  for (const m of [...data.media].sort((a, b) => a.size - b.size)) {
    if (total + m.size > MEDIA_LIMIT) continue;
    const bytes = await store.fileBytes(m.id);
    if (!bytes) continue;
    total += bytes.length;
    m.file = `attachments/${m.id.slice(0, 8)}-${safe(m.name)}`;
    files.push({ name: m.file, bytes });
  }
  const enc = new TextEncoder();
  files.unshift({ name: "project.json", bytes: enc.encode(JSON.stringify(data, null, 1)) }, { name: "project.md", bytes: enc.encode(exportMarkdown(data)) });
  const zip = await zipBackupAsync(files);
  const name = `${safe(page.title)} · AI export ${dayKey(new Date())}.zip`;
  if (!("__TAURI_INTERNALS__" in window)) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([zip as BlobPart], { type: "application/zip" }));
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
    return name;
  }
  const [{ save }, { writeFile }] = await Promise.all([import("@tauri-apps/plugin-dialog"), import("@tauri-apps/plugin-fs")]);
  const path = await save({ defaultPath: name, filters: [{ name: "Project export", extensions: ["zip"] }] });
  if (!path) return null;
  await writeFile(path, zip);
  return path;
}
