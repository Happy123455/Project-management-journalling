export type Clip = { kind: "url"; url: string } | { kind: "text"; text: string; lines: number };

const URL_RE = /^https?:\/\/[^\s<>"]+$/i;

/** What the clipboard holds, or null when there is nothing worth suggesting. */
export function classifyClip(raw: string | null | undefined): Clip | null {
  const text = (raw ?? "").replace(/\r\n?/g, "\n").trim();
  if (!text) return null;
  if (URL_RE.test(text)) return { kind: "url", url: text };
  return { kind: "text", text, lines: text.split("\n").length };
}

/** Short, stable id for a clipboard item, so a dismissed one stays hidden. */
export function clipKey(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return `${text.length}:${(h >>> 0).toString(36)}`;
}

/** One-line preview for the suggestion chip. */
export function clipPreview(clip: Clip, max = 40): string {
  const text = clip.kind === "url" ? clip.url.replace(/^https?:\/\//i, "") : clip.text.split("\n")[0];
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

/** Attributes that carry our photos, videos, PDFs and files through copy and paste. */
const MEDIA_ATTRS = new Set(["data-file-id", "data-media", "data-attachment", "data-width", "data-align", "data-name", "data-mime", "data-size"]);

/**
 * Removes what other apps bring along when pasting: inline styles, classes, fonts,
 * colours and empty spans. Structure (paragraphs, lists, links, bold, italic) stays.
 */
export function cleanPastedHTML(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("style, script, meta, link, title").forEach((el) => el.remove());
  doc.body.querySelectorAll("*").forEach((el) => {
    for (const attr of [...el.attributes]) {
      const keep =
        (el.tagName === "A" && attr.name === "href") ||
        (el.tagName === "IMG" && ["src", "alt"].includes(attr.name)) ||
        MEDIA_ATTRS.has(attr.name);
      if (!keep) el.removeAttribute(attr.name);
    }
  });
  // Unwrap spans and fonts, which only carried styling (but keep our media spans).
  doc.body.querySelectorAll("span:not([data-media]), font").forEach((el) => el.replaceWith(...el.childNodes));
  return doc.body.innerHTML;
}
