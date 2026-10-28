import type { SyncFolder } from "./engine";

export const SYNC_FOLDER_NAME = "Dynamic Journal Sync";

declare global {
  interface Window {
    /** Android: the picked Google Drive folder (MainActivity.kt SyncBridge). */
    JournalSync?: {
      folderName(): string;
      pick(): void;
      list(path: string): string;
      read(path: string): string;
      write(path: string, data: string): boolean;
      exists(path: string): boolean;
    };
    __journalSyncPicked?: (ok: boolean) => void;
  }
}

const toB64 = (bytes: Uint8Array) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

/** Android: the folder Hapi picked once in the system picker (Google Drive appears there). */
class AndroidFolder implements SyncFolder {
  constructor(private bridge: NonNullable<Window["JournalSync"]>) {}
  async list(dir: string) {
    return JSON.parse(this.bridge.list(dir)) as string[];
  }
  async read(path: string) {
    const data = this.bridge.read(path);
    return data === "!" ? null : Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  }
  async write(path: string, bytes: Uint8Array) {
    if (!this.bridge.write(path, toB64(bytes))) throw new Error(`Couldn't write ${path} to the sync folder`);
  }
  async exists(path: string) {
    return this.bridge.exists(path);
  }
}

/** Mac: "Dynamic Journal Sync" inside the Google Drive for desktop folder. */
class MacFolder implements SyncFolder {
  constructor(private base: string) {}
  private fs = () => import("@tauri-apps/plugin-fs");
  private at = (path: string) => (path ? `${this.base}/${path}` : this.base);
  async list(dir: string) {
    const fs = await this.fs();
    if (!(await fs.exists(this.at(dir)))) return [];
    return (await fs.readDir(this.at(dir))).map((e) => e.name);
  }
  async read(path: string) {
    const fs = await this.fs();
    return (await fs.exists(this.at(path))) ? fs.readFile(this.at(path)) : null;
  }
  async write(path: string, bytes: Uint8Array) {
    const fs = await this.fs();
    const full = this.at(path);
    await fs.mkdir(full.slice(0, full.lastIndexOf("/")), { recursive: true });
    await fs.writeFile(full, bytes);
  }
  async exists(path: string) {
    return (await this.fs()).exists(this.at(path));
  }
}

export type FolderLookup =
  | { kind: "ready"; folder: SyncFolder; label: string }
  /** Android, nothing picked yet: ask Hapi to choose the Drive folder. */
  | { kind: "pick" }
  | { kind: "unavailable"; reason: string };

/** Finds the sync folder for this device. */
export async function findSyncFolder(): Promise<FolderLookup> {
  const bridge = window.JournalSync;
  if (bridge) {
    const name = bridge.folderName();
    return name ? { kind: "ready", folder: new AndroidFolder(bridge), label: `Google Drive › ${name}` } : { kind: "pick" };
  }
  if (!("__TAURI_INTERNALS__" in window)) return { kind: "unavailable", reason: "Sync runs in the app." };
  const [fs, { homeDir, join }] = await Promise.all([import("@tauri-apps/plugin-fs"), import("@tauri-apps/api/path")]);
  const cloud = await join(await homeDir(), "Library", "CloudStorage");
  const drives = (await fs.exists(cloud)) ? (await fs.readDir(cloud)).filter((e) => e.name.startsWith("GoogleDrive-")) : [];
  if (!drives.length) return { kind: "unavailable", reason: "Google Drive for desktop isn't set up on this Mac." };
  const base = await join(cloud, drives[0].name, "My Drive", SYNC_FOLDER_NAME);
  return { kind: "ready", folder: new MacFolder(base), label: `Google Drive › My Drive › ${SYNC_FOLDER_NAME}` };
}

/** Android: opens the system folder picker; resolves when Hapi has chosen (true) or cancelled. */
export function pickSyncFolder(): Promise<boolean> {
  return new Promise((resolve) => {
    window.__journalSyncPicked = (ok) => {
      delete window.__journalSyncPicked;
      resolve(ok);
    };
    window.JournalSync?.pick();
  });
}
