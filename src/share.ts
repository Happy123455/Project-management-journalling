import { appendBlocks, asBlocks, textBlocks } from "./lib/append";
import { docText } from "./lib/words";
import { mediaNode } from "./editor/attachments";
import type { JournalStore } from "./store";

declare global {
  interface Window {
    /** Android: shares and quick-note launches (MainActivity.kt ShareBridge). */
    JournalShare?: { take(): string; showKeyboard(): void };
  }
}

interface SharePayload {
  quickNote: boolean;
  text?: string;
  files: { name: string; mime: string; data: string }[];
  skipped: string[];
}

export interface ShareResult {
  quickNote: boolean;
  added: number;
  skipped: string[];
}

/** Takes whatever was shared into the app (if anything) and adds it to the end of `day`'s note. */
export async function takeShare(store: JournalStore, day: string): Promise<ShareResult | null> {
  const raw = window.JournalShare?.take();
  if (!raw) return null;
  const share = JSON.parse(raw) as SharePayload;
  const blocks = share.text ? textBlocks(share.text) : [];
  const media = [];
  for (const f of share.files) {
    const bytes = Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0));
    media.push(mediaNode(await store.saveFile({ name: f.name, mime: f.mime, bytes })));
  }
  blocks.push(...asBlocks(media));
  if (blocks.length) {
    const page = await store.getDay(day);
    const content = appendBlocks(page?.content ?? null, blocks);
    await store.saveDay({ day, content, plainText: docText(content) });
  }
  return { quickNote: share.quickNote, added: share.files.length + (share.text ? 1 : 0), skipped: share.skipped };
}
