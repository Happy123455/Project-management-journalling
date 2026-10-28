import { safeFileName, sha256 } from "../lib/files";
import { newId } from "./ids";
import type { FileRecord, SaveFileInput } from "./types";

/** The record for a new attachment; both stores use it so ids, paths and hashes match. */
export async function newFileRecord({ name, mime, bytes }: SaveFileInput): Promise<FileRecord> {
  const id = newId();
  return {
    id,
    name,
    mime: mime || "application/octet-stream",
    size: bytes.byteLength,
    hash: await sha256(bytes),
    path: `attachments/${id}/${safeFileName(name)}`,
    createdAt: new Date().toISOString(),
  };
}

/** What a file's create event records (everything but the bytes). */
export const fileEventBody = (f: FileRecord) => JSON.stringify({ name: f.name, mime: f.mime, size: f.size, hash: f.hash, path: f.path });

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(data: string): Uint8Array {
  return Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
}
