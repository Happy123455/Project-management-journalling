import type { StorageUsage, SyncFolder } from "./engine";

export const SYNC_FOLDER_NAME = "Dynamic Journal Sync";

declare global {
  interface Window {
    /** Android: Google Drive sign-in (MainActivity.kt SyncBridge). */
    JournalSync?: {
      driveToken(id: string, interactive: boolean): void;
    };
    __journalDriveToken?: (id: string, token: string) => void;
  }
}

const waiting = new Map<string, (token: string) => void>();
let nextRequest = 0;

/** Android: a Google Drive access token, or "" when Hapi hasn't signed in (or cancelled). */
function driveToken(interactive: boolean): Promise<string> {
  window.__journalDriveToken ??= (id, token) => {
    waiting.get(id)?.(token);
    waiting.delete(id);
  };
  const id = String(++nextRequest);
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    window.JournalSync?.driveToken(id, interactive);
  });
}

const API = "https://www.googleapis.com/drive/v3/files";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const FOLDER = "application/vnd.google-apps.folder";
/** Drive folder ids by path relative to the sync folder ("" is the sync folder itself); they never change. */
const folderIds = new Map<string, string>();

const quote = (name: string) => `'${name.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
const split = (path: string): [string, string] => {
  const i = path.lastIndexOf("/");
  return i < 0 ? ["", path] : [path.slice(0, i), path.slice(i + 1)];
};

/** Android: "Dynamic Journal Sync" in My Drive, through the Drive API (the Mac sees the same folder). */
export class DriveFolder implements SyncFolder {
  constructor(private token: string) {}
  /** Size and time of the files `list` saw, by path. */
  private stamps = new Map<string, string>();

  private async call(url: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetch(url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${this.token}` } });
    if (res.status === 401) throw new Error("Google Drive sign-in expired. Tap Sync now to sign in again.");
    if (!res.ok && res.status !== 404) throw new Error(`Google Drive said ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res;
  }

  private async search(q: string, fields: string): Promise<{ id: string; name: string; size?: string; modifiedTime?: string }[]> {
    const found: { id: string; name: string; size?: string; modifiedTime?: string }[] = [];
    let pageToken = "";
    do {
      const params = new URLSearchParams({ q: `${q} and trashed = false`, fields: `nextPageToken, files(${fields})`, pageSize: "1000" });
      if (pageToken) params.set("pageToken", pageToken);
      const page = await (await this.call(`${API}?${params}`)).json();
      found.push(...page.files);
      pageToken = page.nextPageToken ?? "";
    } while (pageToken);
    return found;
  }

  private async child(parent: string, name: string, folder = false): Promise<string | null> {
    const kind = folder ? ` and mimeType = '${FOLDER}'` : ` and mimeType != '${FOLDER}'`;
    return (await this.search(`${quote(parent)} in parents and name = ${quote(name)}${kind}`, "id"))[0]?.id ?? null;
  }

  /** The folder's id, creating it (and its parents) when asked. */
  private async dir(path: string, create: boolean): Promise<string | null> {
    const known = folderIds.get(path);
    if (known) return known;
    const [up, name] = path ? split(path) : ["", SYNC_FOLDER_NAME];
    const parent = path ? await this.dir(up, create) : "root";
    if (!parent) return null;
    let id = await this.child(parent, name, true);
    if (!id && create) {
      const res = await this.call(`${API}?fields=id`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, mimeType: FOLDER, parents: [parent] }),
      });
      id = (await res.json()).id as string;
    }
    if (id) folderIds.set(path, id);
    return id;
  }

  private async file(path: string): Promise<string | null> {
    const [up, name] = split(path);
    const parent = await this.dir(up, false);
    return parent ? this.child(parent, name) : null;
  }

  async list(dir: string) {
    const id = await this.dir(dir, false);
    if (!id) return [];
    const files = await this.search(`${quote(id)} in parents`, "id, name, size, modifiedTime");
    for (const f of files) this.stamps.set(dir ? `${dir}/${f.name}` : f.name, `${f.size}-${f.modifiedTime}`);
    return files.map((f) => f.name);
  }

  async stamp(path: string) {
    return this.stamps.get(path) ?? null;
  }

  async usage(): Promise<StorageUsage> {
    const about = await (await this.call("https://www.googleapis.com/drive/v3/about?fields=storageQuota")).json();
    const q = about.storageQuota ?? {};
    let folderBytes = 0;
    let files = 0;
    const walk = async (id: string) => {
      for (const f of await this.search(`${quote(id)} in parents`, "id, size, mimeType")) {
        if ((f as { mimeType?: string }).mimeType === FOLDER) await walk(f.id);
        else {
          folderBytes += Number(f.size ?? 0);
          files++;
        }
      }
    };
    const root = await this.dir("", false);
    if (root) await walk(root);
    return { folderBytes, files, account: { limit: q.limit ? Number(q.limit) : null, usage: Number(q.usage ?? 0), drive: Number(q.usageInDrive ?? 0) } };
  }

  async read(path: string) {
    const id = await this.file(path);
    if (!id) return null;
    const res = await this.call(`${API}/${id}?alt=media`);
    return res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
  }

  async write(path: string, bytes: Uint8Array) {
    const [up, name] = split(path);
    const parent = (await this.dir(up, true))!;
    const id = await this.child(parent, name);
    if (id) {
      await this.call(`${UPLOAD}/${id}?uploadType=media`, { method: "PATCH", body: new Blob([bytes as BlobPart]) });
      return;
    }
    const boundary = `journal${Date.now()}`;
    const body = new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, parents: [parent] })}\r\n`,
      `--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`,
      bytes as BlobPart,
      `\r\n--${boundary}--`,
    ]);
    await this.call(`${UPLOAD}?uploadType=multipart&fields=id`, {
      method: "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
    });
  }

  async exists(path: string) {
    return (await this.file(path)) !== null;
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
  async stamp(path: string) {
    const info = await (await this.fs()).stat(this.at(path));
    return `${info.size}-${info.mtime?.getTime()}`;
  }
  /** The Mac only sees the folder; the account's storage comes from the phone (Drive API). */
  async usage(): Promise<StorageUsage> {
    const fs = await this.fs();
    let folderBytes = 0;
    let files = 0;
    const walk = async (dir: string) => {
      for (const e of await fs.readDir(this.at(dir))) {
        const path = dir ? `${dir}/${e.name}` : e.name;
        if (e.isDirectory) await walk(path);
        else {
          folderBytes += (await fs.stat(this.at(path))).size;
          files++;
        }
      }
    };
    if (await fs.exists(this.base)) await walk("");
    return { folderBytes, files };
  }
}

export type FolderLookup =
  | { kind: "ready"; folder: SyncFolder; label: string }
  /** Android, not signed in to Google Drive yet. */
  | { kind: "pick" }
  | { kind: "unavailable"; reason: string };

/** Finds the sync folder for this device (`me`: its device id). */
export async function findSyncFolder(me: string): Promise<FolderLookup> {
  if (window.JournalSync) {
    const token = await driveToken(false);
    return token ? { kind: "ready", folder: new DriveFolder(token), label: `Google Drive › My Drive › ${SYNC_FOLDER_NAME}` } : { kind: "pick" };
  }
  if (!("__TAURI_INTERNALS__" in window)) return { kind: "unavailable", reason: "Sync runs in the app." };
  const [fs, { homeDir, join }] = await Promise.all([import("@tauri-apps/plugin-fs"), import("@tauri-apps/api/path")]);
  const cloud = await join(await homeDir(), "Library", "CloudStorage");
  // Drive leaves "GoogleDrive-<account> (date)" copies behind when an account is re-added; skip those.
  const drives = (await fs.exists(cloud)) ? (await fs.readDir(cloud)).map((e) => e.name).filter((n) => /^GoogleDrive-[^ ]+$/.test(n)) : [];
  if (!drives.length) return { kind: "unavailable", reason: "Google Drive for desktop isn't set up on this Mac." };
  // With several accounts signed in, use the one where other devices (the phone) already sync.
  let best = drives[0];
  let most = -1;
  for (const d of drives.sort()) {
    const events = await join(cloud, d, "My Drive", SYNC_FOLDER_NAME, "events");
    const others = (await fs.exists(events)) ? (await fs.readDir(events)).filter((e) => e.name !== me).length : -1;
    if (others > most) [best, most] = [d, others];
  }
  const base = await join(cloud, best, "My Drive", SYNC_FOLDER_NAME);
  const account = best.slice("GoogleDrive-".length);
  return { kind: "ready", folder: new MacFolder(base), label: `Google Drive (${account}) › My Drive › ${SYNC_FOLDER_NAME}` };
}

/** Android: Google sign-in (account chooser, then Drive consent); resolves true once signed in. */
export async function pickSyncFolder(): Promise<boolean> {
  return !!(await driveToken(true));
}

/** The sync folder's size and, on the phone, the Google account's storage. */
export async function syncStorage(): Promise<StorageUsage | null> {
  const found = await findSyncFolder("");
  return found.kind === "ready" && found.folder.usage ? found.folder.usage() : null;
}
