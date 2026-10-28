import type { JSONContent } from "@tiptap/react";

const MEDIA_NODES = new Set(["attachmentImage", "attachmentMedia", "attachmentFile"]);

/** The stored files a page shows (photos, videos, PDFs, files), in page order, each once. */
export function mediaIdsIn(doc: JSONContent | null | undefined): string[] {
  const ids: string[] = [];
  const walk = (node: JSONContent) => {
    if (node.type && MEDIA_NODES.has(node.type) && node.attrs?.fileId && !ids.includes(node.attrs.fileId)) ids.push(node.attrs.fileId);
    node.content?.forEach(walk);
  };
  if (doc) walk(doc);
  return ids;
}
