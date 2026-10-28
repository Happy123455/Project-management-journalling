import type { Editor, JSONContent } from "@tiptap/react";
import { appendBlocks, textBlocks } from "../lib/append";
import { showError, showToast } from "../lib/toast";
import { docText } from "../lib/words";
import { journalStore } from "./attachments";

export const INSPIRATION = "Inspiration";

const TOP_TYPES = ["paragraph", "heading", "blockquote", "bulletList", "orderedList", "taskList", "codeBlock", "attachmentFile", "linkCard"];

/** The top-level block the cursor is in. */
function currentTopBlock(editor: Editor): JSONContent | null {
  const { $from } = editor.state.selection;
  if ($from.depth < 1) return null;
  const node = $from.node(1);
  return TOP_TYPES.includes(node.type.name) ? node.toJSON() : null;
}

/** Saves the current block (or, when it's empty, what's on the clipboard) to the Inspiration page. */
export async function saveToInspiration(editor: Editor, where: string) {
  const store = journalStore();
  if (!store) return;
  try {
    let blocks: JSONContent[] = [];
    const block = currentTopBlock(editor);
    if (block && (docText(block).trim() || JSON.stringify(block).includes("fileId") || block.type === "linkCard")) blocks = [block];
    else {
      const text = await navigator.clipboard?.readText?.().catch(() => "");
      if (text?.trim()) blocks = /^https?:\/\/\S+$/.test(text.trim()) ? [{ type: "linkCard", attrs: { url: text.trim() } }] : textBlocks(text);
    }
    if (!blocks.length) return showToast("Nothing to save — put the cursor in a block, or copy something first.");
    const page = await store.ensurePage(INSPIRATION);
    const fresh = (await store.getPage(INSPIRATION)) ?? page;
    // Each saved item is followed by a small line saying where it came from.
    const source = { type: "paragraph", attrs: { info: { From: where } }, content: [] };
    const content = appendBlocks(fresh.content, [...blocks, source]);
    await store.savePage({ id: page.id, content, plainText: docText(content) });
    showToast("✨ Saved to Inspiration");
  } catch (e) {
    showError("Couldn't save to Inspiration", e);
  }
}

/** Groups an Inspiration page's blocks into items: everything up to each "From" line is one card. */
export function inspirationItems(doc: JSONContent): JSONContent[][] {
  const items: JSONContent[][] = [];
  let current: JSONContent[] = [];
  for (const block of doc.content ?? []) {
    if (block.type === "paragraph" && block.attrs?.info?.From && !block.content?.length) {
      if (current.length) items.push(current);
      current = [];
      continue;
    }
    if (block.type === "paragraph" && !block.content?.length) continue;
    current.push(block);
  }
  if (current.length) items.push(current);
  return items;
}
