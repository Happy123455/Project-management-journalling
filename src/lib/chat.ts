import type { JSONContent } from "@tiptap/react";
import { formatTimestamp, TIMESTAMP_RE } from "./timestamp";
import { docText } from "./words";

export interface ChatMessage {
  /** "10:55" from the entry's timestamp. */
  time: string;
  text: string;
}

const logItemText = (item: JSONContent) => docText(item).split("\n")[0] ?? "";

/** Log lines (list items that start with a timestamp) as chat messages, in order. */
export function chatMessages(doc: JSONContent | null): ChatMessage[] {
  const out: ChatMessage[] = [];
  const walk = (node: JSONContent) => {
    if (node.type === "listItem") {
      const text = logItemText(node);
      const m = [...text.matchAll(TIMESTAMP_RE)][0];
      if (m && m.index === 0) out.push({ time: `${m[5]}:${m[6]}`, text: text.slice(m[0].length).trim() });
    }
    node.content?.forEach(walk);
  };
  if (doc) walk(doc);
  return out;
}

const isLogList = (block: JSONContent | undefined) =>
  block?.type === "bulletList" && (block.content ?? []).every((item) => [...logItemText(item).matchAll(TIMESTAMP_RE)][0]?.index === 0);

/** The note with a new log line "<timestamp> text" added: to the log at the end, or as a new one. */
export function appendLogLine(doc: JSONContent | null, text: string, at: Date): JSONContent {
  const item = { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: `${formatTimestamp(at)} ${text.trim()}` }] }] };
  const content = [...(doc?.content ?? [])];
  while (content.length && content[content.length - 1].type === "paragraph" && !content[content.length - 1].content?.length && !content[content.length - 1].attrs?.info) content.pop();
  const last = content[content.length - 1];
  if (isLogList(last)) content[content.length - 1] = { ...last, content: [...(last!.content ?? []), item] };
  else content.push({ type: "bulletList", content: [item] });
  return { type: "doc", content };
}
