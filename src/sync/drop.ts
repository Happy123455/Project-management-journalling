import type { Clip } from "./direct";
import { showToast } from "../lib/toast";

/**
 * Nexus › Send: text, photos, videos and any file sent straight to the other device over the
 * Wi-Fi link (like AirDrop between the phone and the Mac). What arrives is saved to Downloads
 * (Mac: ~/Downloads, phone: Download/Dynamic Journal) and listed in Nexus with what was sent, to
 * copy or put into today's note. The list lives on this device only (IndexedDB), newest 40.
 */
export interface DropItem {
  id: string;
  at: number;
  /** Sent from here (true) or received (false). */
  mine: boolean;
  text?: string;
  name?: string;
  mime?: string;
  size: number;
  /** Where a received file was saved, if it was. */
  savedTo?: string;
}

export const DROP_EVENT = "journal:drop";
const KEEP = 40;
/** Over the Wi-Fi link the bytes travel as text inside the page: keep it to this. */
export const MAX_DROP = 40 * 1024 * 1024;

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open("journal-drop", 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore("items", { keyPath: "id" });
      r.result.createObjectStore("data");
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export async function listDrops(): Promise<DropItem[]> {
  try {
    const d = await db();
    const all = await req<DropItem[]>(d.transaction("items").objectStore("items").getAll());
    return all.sort((a, b) => b.at - a.at);
  } catch {
    return [];
  }
}

/** A file's bytes as base64, or null when gone. */
export async function dropData(id: string): Promise<string | null> {
  try {
    const d = await db();
    return (await req<string | undefined>(d.transaction("data").objectStore("data").get(id))) ?? null;
  } catch {
    return null;
  }
}

export async function addDrop(item: DropItem, data?: string) {
  try {
    const d = await db();
    const tx = d.transaction(["items", "data"], "readwrite");
    tx.objectStore("items").put(item);
    if (data) tx.objectStore("data").put(data, item.id);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    const all = await listDrops();
    if (all.length > KEEP) {
      const t = d.transaction(["items", "data"], "readwrite");
      for (const old of all.slice(KEEP)) {
        t.objectStore("items").delete(old.id);
        t.objectStore("data").delete(old.id);
      }
    }
  } catch {
    /* the list is a convenience: the file itself was saved or sent */
  }
  window.dispatchEvent(new CustomEvent(DROP_EVENT));
}

export async function removeDrop(id: string) {
  const d = await db();
  const tx = d.transaction(["items", "data"], "readwrite");
  tx.objectStore("items").delete(id);
  tx.objectStore("data").delete(id);
  window.dispatchEvent(new CustomEvent(DROP_EVENT));
}

export const base64Size = (b64: string) => Math.floor((b64.length * 3) / 4) - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0);

const isAndroid = () => /Android/i.test(navigator.userAgent);
const inApp = () => "__TAURI_INTERNALS__" in window;

declare global {
  interface Window {
    /** Android: MainActivity.kt DropBridge. */
    JournalDrop?: { save(name: string, mime: string, data: string): boolean };
  }
}

/** Saves a received file to Downloads; where it went, or undefined. */
export async function saveToDownloads(name: string, mime: string, data: string): Promise<string | undefined> {
  const safe = name.replace(/[/\\:]/g, "_") || "file";
  if (isAndroid()) return window.JournalDrop?.save(safe, mime, data) ? "Download/Dynamic Journal" : undefined;
  if (!inApp()) {
    const a = document.createElement("a");
    a.href = `data:${mime || "application/octet-stream"};base64,${data}`;
    a.download = safe;
    a.click();
    return "Downloads";
  }
  try {
    const fs = await import("@tauri-apps/plugin-fs");
    const opts = { baseDir: fs.BaseDirectory.Download };
    // photo.jpg, photo (2).jpg, … never over a file already there.
    const dot = safe.lastIndexOf(".");
    const [stem, ext] = dot > 0 ? [safe.slice(0, dot), safe.slice(dot)] : [safe, ""];
    let file = safe;
    for (let i = 2; await fs.exists(file, opts); i++) file = `${stem} (${i})${ext}`;
    await fs.writeFile(file, Uint8Array.from(atob(data), (c) => c.charCodeAt(0)), opts);
    return `Downloads/${file}`;
  } catch {
    return undefined;
  }
}

/** Something sent from the other device's Nexus. */
export async function receiveDrop(c: Clip, other: string) {
  const item: DropItem = { id: c.id, at: c.at || Date.now(), mine: false, text: c.text, name: c.name, mime: c.mime, size: c.data ? base64Size(c.data) : (c.text?.length ?? 0) };
  if (c.data) item.savedTo = await saveToDownloads(c.name ?? "file", c.mime ?? "", c.data);
  await addDrop(item, c.data);
  window.JournalHaptics?.play("edge", 0.7);
  showToast(
    c.data
      ? `📥 ${c.name ?? "A file"} from ${other}${item.savedTo ? ` · saved to ${item.savedTo}` : " · in Nexus › Send"}`
      : `📥 Text from ${other} · in Nexus › Send`,
    "info",
    undefined,
    { background: true },
  );
}
