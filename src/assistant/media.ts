// Photos, memes, GIFs, sounds and other files for the assistant (16 Nov: it used to write
// "![name](name)" or "/meme …" as plain text, which never loaded). find_media lists what can be
// added, add_media puts real attachment blocks in a note, saved like a picked file.
import type { JSONContent } from "@tiptap/core";
import type { FileRecord, JournalStore } from "../store";
import { fileKind } from "../lib/files";
import { recentGallery, readGallery, type GalleryItem } from "./phonePhotos";

export type MediaSource = "phone" | "journal" | "memes";

export interface MediaHit {
  source: MediaSource;
  name: string;
  /** "photo", "video", "gif", "sound", "greenscreen", "audio", "pdf" or "file". */
  kind: string;
  /** When it was taken or added (ms), if known. */
  at?: number;
  gallery?: GalleryItem;
  file?: FileRecord;
  kit?: { file: string; kind: string; name: string };
}

interface KitItem {
  id: string;
  kind: "photo" | "gif" | "sound" | "greenscreen";
  name: string;
  file: string;
  tags?: string[];
}

const KIT = "/meme-kit/";
let kitIndex: Promise<KitItem[]> | null = null;
const loadKit = (): Promise<KitItem[]> => (kitIndex ??= fetch(`${KIT}index.json`).then((r) => (r.ok ? (r.json() as Promise<KitItem[]>) : [])).catch(() => []));

const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
/** How well a name (and tags) matches the words asked for: 0 = not at all. */
function score(query: string, ...texts: string[]): number {
  const want = words(query);
  if (!want.length) return 1;
  const have = words(texts.join(" "));
  let n = 0;
  for (const w of want) if (have.some((h) => h === w || h.startsWith(w) || (w.length > 3 && h.includes(w)))) n++;
  return n / want.length;
}

/** What kind of thing a stored file is, the way a person would say it. */
function journalKind(f: FileRecord): string {
  const k = fileKind(f.mime);
  if (/^(meme-)/i.test(f.name)) return "photo";
  if (/^(gif-)/i.test(f.name) || /gif$/i.test(f.mime)) return "gif";
  if (/^sound-/i.test(f.name)) return "sound";
  if (/^greenscreen-/i.test(f.name)) return "greenscreen";
  return k === "image" ? "photo" : k;
}

const kindOk = (want: string, kind: string) => {
  if (!want || want === "any") return true;
  if (want === "meme") return kind === "photo" || kind === "gif" || kind === "greenscreen";
  if (want === "audio") return kind === "audio" || kind === "sound";
  if (want === "sound") return kind === "sound" || kind === "audio";
  if (want === "image" || want === "picture") return kind === "photo" || kind === "gif";
  return kind === want;
};

/** Things that can be added, best first: newest first for the phone and the journal, best match for memes. */
export async function findMedia(store: JournalStore, opts: { source?: string; query?: string; kind?: string; limit?: number }): Promise<MediaHit[] | string> {
  const source = (opts.source ?? "journal") as MediaSource;
  const query = String(opts.query ?? "").trim();
  const kind = String(opts.kind ?? "any").toLowerCase();
  const limit = Math.max(1, Math.min(50, Number(opts.limit) || 10));
  if (source === "phone") {
    const items = await recentGallery(Math.max(limit * 4, 40));
    if (typeof items === "string") return items;
    return items
      .map((g): MediaHit => ({ source, name: g.name, kind: g.mime.startsWith("video/") ? "video" : "photo", at: g.taken, gallery: g }))
      .filter((h) => kindOk(kind, h.kind) && (!query || score(query, h.name) > 0))
      .slice(0, limit);
  }
  if (source === "memes") {
    const kit = await loadKit();
    if (!kit.length) return "The meme kit isn't in this app.";
    return kit
      .map((k) => ({ k, s: score(query, k.name, ...(k.tags ?? [])) }))
      .filter(({ k, s }) => s > 0 && kindOk(kind, k.kind))
      .sort((a, b) => b.s - a.s)
      .slice(0, limit)
      .map(({ k }) => ({ source, name: k.name, kind: k.kind, kit: { file: k.file, kind: k.kind, name: k.name } }));
  }
  const files = await store.listFiles();
  return files
    .map((f): MediaHit => ({ source: "journal", name: f.name, kind: journalKind(f), at: Date.parse(f.createdAt) || undefined, file: f }))
    .filter((h) => kindOk(kind, h.kind) && (!query || score(query, h.name) > 0))
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
    .slice(0, limit);
}

/** The stored file for a hit (saved into the journal when it comes from the phone or the meme kit). */
export async function storedFile(store: JournalStore, hit: MediaHit): Promise<FileRecord | string> {
  if (hit.file) return hit.file;
  let file: File;
  if (hit.gallery) {
    const f = await readGallery(hit.gallery);
    if (typeof f === "string") return f;
    file = f;
  } else if (hit.kit) {
    const res = await fetch(KIT + hit.kit.file);
    if (!res.ok) return `Couldn't load ${hit.name} from the meme kit.`;
    const blob = await res.blob();
    const ext = hit.kit.file.split(".").pop();
    const stem = hit.kit.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    // Named like the meme picker's, so they count as memes and sounds show with a 🔊.
    const prefix = { sound: "sound", gif: "gif", greenscreen: "greenscreen", photo: "meme" }[hit.kit.kind] ?? "meme";
    file = new File([blob], `${prefix}-${stem}.${ext}`, { type: blob.type || (hit.kit.kind === "sound" ? "audio/mpeg" : hit.kit.kind === "photo" ? "image/png" : "video/mp4") });
  } else return "Nothing to add.";
  return store.saveFile({ name: file.name || "file", mime: file.type, bytes: new Uint8Array(await file.arrayBuffer()) });
}

/** The block that shows a stored file (the same nodes a picked file becomes). */
export function mediaBlock(r: FileRecord): JSONContent {
  const kind = fileKind(r.mime);
  if (kind === "image") return { type: "paragraph", content: [{ type: "attachmentImage", attrs: { fileId: r.id, name: r.name, align: "inline" } }] };
  if (kind === "video" || kind === "pdf" || kind === "audio") return { type: "paragraph", content: [{ type: "attachmentMedia", attrs: { fileId: r.id, kind, name: r.name, mime: r.mime, size: r.size, align: "inline" } }] };
  return { type: "attachmentFile", attrs: { fileId: r.id, name: r.name, mime: r.mime, size: r.size } };
}

const ago = (ms: number, now: number) => {
  const m = Math.round((now - ms) / 60000);
  if (m < 60) return `${Math.max(0, m)} min ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)} h ago`;
  return new Date(ms).toISOString().slice(0, 10);
};

/** A numbered list for the AI. */
export const describeHits = (hits: MediaHit[], now: number) =>
  hits.map((h, i) => `${i + 1}. ${h.name} (${h.kind}, ${h.source}${h.at ? `, ${ago(h.at, now)}` : ""})`).join("\n");
