import { fileKind, type FileKind } from "./files";

/**
 * Obsidian-style embeds for media in plain text: ![[attachments/<id>/<name>]] or ![[name.png]],
 * optionally with a width: ![[name.png|300]].
 */
export const EMBED_RE = /!\[\[([^\[\]|\n]+?)(?:\|(\d+))?\]\]/g;

export type Segment = { type: "text"; text: string } | { type: "embed"; ref: string; width: number | null };

/** Splits text into plain runs and embeds, in order. */
export function parseEmbeds(text: string): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  for (const m of text.matchAll(EMBED_RE)) {
    if (m.index > last) out.push({ type: "text", text: text.slice(last, m.index) });
    out.push({ type: "embed", ref: m[1].trim(), width: m[2] ? Number(m[2]) : null });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ type: "text", text: text.slice(last) });
  return out;
}

export const hasEmbeds = (text: string) => /!\[\[[^\[\]\n]+\]\]/.test(text);

/** The embed text for a stored file. */
export function embedText(fileId: string, name: string, width?: number | null): string {
  return `![[attachments/${fileId}/${name}${width ? `|${width}` : ""}]]`;
}

/** The file id inside an "attachments/<id>/<name>" reference, or null for a bare name. */
export function idFromRef(ref: string): string | null {
  return ref.match(/^attachments\/([^/]+)\/[^/]+$/)?.[1] ?? null;
}

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", heic: "image/heic",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", "3gp": "video/3gpp",
  pdf: "application/pdf",
};

/** A best guess at a file's type from its name, for references whose record isn't at hand. */
export function mimeFromName(name: string): string {
  return MIME_BY_EXT[name.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";
}

export const kindFromName = (name: string): FileKind => fileKind(mimeFromName(name));
