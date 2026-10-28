export type SlashId =
  | "heading" | "task" | "bullet" | "numbered" | "quote" | "code"
  | "divider" | "timestamp" | "link" | "tag" | "reminder"
  | "attach" | "camera" | "video" | "qr";

export interface SlashItem {
  id: SlashId;
  label: string;
  icon: string;
  /** Other words that find this tile when typed after "/". */
  keywords: string[];
}

/** Tiles in the "/" menu. Bold, italic and highlight live in the toolbar instead. */
export const SLASH_ITEMS: SlashItem[] = [
  { id: "heading", label: "Heading", icon: "H", keywords: ["title", "h2"] },
  { id: "task", label: "Task", icon: "☑", keywords: ["todo", "checkbox", "check"] },
  { id: "bullet", label: "Bullets", icon: "•", keywords: ["list", "unordered"] },
  { id: "numbered", label: "Numbers", icon: "1.", keywords: ["list", "ordered"] },
  { id: "quote", label: "Quote", icon: "❝", keywords: ["blockquote", "cite"] },
  { id: "code", label: "Code", icon: "</>", keywords: ["codeblock", "snippet"] },
  { id: "divider", label: "Divider", icon: "—", keywords: ["line", "hr", "separator"] },
  { id: "timestamp", label: "Timestamp", icon: "🕒", keywords: ["time", "now", "clock"] },
  { id: "link", label: "Link page", icon: "[[ ]]", keywords: ["wikilink", "page", "person"] },
  { id: "tag", label: "Tag", icon: "#", keywords: ["hashtag", "label"] },
  { id: "reminder", label: "Reminder", icon: "🔔", keywords: ["future", "remind", "later", "date"] },
  { id: "attach", label: "Attach", icon: "📎", keywords: ["file", "pdf", "photo", "image", "upload", "document"] },
  { id: "camera", label: "Photo", icon: "📷", keywords: ["camera", "picture", "image", "snap"] },
  { id: "video", label: "Video", icon: "🎥", keywords: ["camera", "record", "clip"] },
  { id: "qr", label: "Scan QR", icon: "🔳", keywords: ["qr", "barcode", "scan", "code"] },
];

/** Tiles matching what was typed after "/": label matches first, then keyword matches. */
export function filterSlashItems(query: string, items: SlashItem[] = SLASH_ITEMS): SlashItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  const byLabel = items.filter((i) => i.label.toLowerCase().includes(q));
  const byKeyword = items.filter((i) => !byLabel.includes(i) && i.keywords.some((k) => k.startsWith(q)));
  return [...byLabel, ...byKeyword];
}
