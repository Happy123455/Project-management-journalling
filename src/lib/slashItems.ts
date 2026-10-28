export type SlashId =
  | "heading" | "task" | "bullet" | "numbered" | "quote" | "code"
  | "divider" | "timestamp" | "link" | "tag" | "reminder"
  | "attach" | "capture" | "project" | "log" | "voice" | "meme" | "sound";

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
  { id: "voice", label: "Voice", icon: "🎙", keywords: ["audio", "record", "voice note", "mic"] },
  { id: "meme", label: "Meme", icon: "😂", keywords: ["gif", "funny", "reaction", "sticker"] },
  { id: "sound", label: "Sound", icon: "🔊", keywords: ["audio", "effect", "clip", "sfx"] },
  { id: "project", label: "Project", icon: "📌", keywords: ["tracker", "goal", "plan", "todo"] },
  { id: "log", label: "Log", icon: "🪵", keywords: ["timestamp", "entries", "diary", "time"] },
  { id: "capture", label: "Capture", icon: "📷", keywords: ["camera", "photo", "picture", "video", "record", "qr", "scan", "barcode"] },
];

/** Tiles matching what was typed after "/": label matches first, then keyword matches. */
export function filterSlashItems(query: string, items: SlashItem[] = SLASH_ITEMS): SlashItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  const byLabel = items.filter((i) => i.label.toLowerCase().includes(q));
  const byKeyword = items.filter((i) => !byLabel.includes(i) && i.keywords.some((k) => k.startsWith(q)));
  return [...byLabel, ...byKeyword];
}
