/** Hex SHA-256 of some bytes; used to spot duplicate attachments. */
export async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A file name safe to keep on disk on any system: letters, digits, dots, dashes and underscores. */
export function safeFileName(name: string): string {
  const cleaned = name.normalize("NFKD").replace(/[^\w.-]+/g, "_").replace(/_+/g, "_").replace(/^[._]+/, "");
  return cleaned.slice(-80) || "file";
}

/** "12 KB", "3.4 MB". */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export type FileKind = "image" | "video" | "pdf" | "file";

export function fileKind(mime: string): FileKind {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime === "application/pdf") return "pdf";
  return "file";
}
