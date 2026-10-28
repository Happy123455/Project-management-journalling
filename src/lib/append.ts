import type { JSONContent } from "@tiptap/react";

/** Paragraphs for shared text: lone links become tappable links, blank lines are kept. */
export function textBlocks(text: string): JSONContent[] {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => {
      const t = line.trim();
      if (!t) return { type: "paragraph" };
      const isUrl = /^https?:\/\/\S+$/i.test(t);
      return { type: "paragraph", content: [{ type: "text", text: t, ...(isUrl ? { marks: [{ type: "link", attrs: { href: t } }] } : {}) }] };
    });
}

/** Wraps inline media (photos, videos, PDFs) in paragraphs; block media stays as it is. */
export function asBlocks(nodes: JSONContent[]): JSONContent[] {
  const out: JSONContent[] = [];
  let inline: JSONContent[] = [];
  const flush = () => {
    if (inline.length) out.push({ type: "paragraph", content: inline });
    inline = [];
  };
  for (const n of nodes) {
    if (n.type === "attachmentFile") {
      flush();
      out.push(n);
    } else {
      inline.push(n);
    }
  }
  flush();
  return out;
}

/** The document with `blocks` added at the end (an empty trailing paragraph is reused). */
export function appendBlocks(doc: JSONContent | null, blocks: JSONContent[]): JSONContent {
  const content = [...(doc?.content ?? [])];
  const last = content[content.length - 1];
  if (last?.type === "paragraph" && !last.content?.length) content.pop();
  return { type: "doc", content: [...content, ...blocks] };
}
