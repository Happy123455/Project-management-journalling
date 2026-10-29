import { appendBlocks, asBlocks, textBlocks } from "./lib/append";
import { docText } from "./lib/words";
import { formatTimestamp } from "./lib/timestamp";
import { isLoneUrl } from "./editor/linkCard";
import { mediaNode } from "./editor/attachments";
import type { JournalStore } from "./store";

declare global {
  interface Window {
    /** Android: shares and quick-note launches (MainActivity.kt ShareBridge). */
    JournalShare?: { take(): string; showKeyboard(): void; takeNotes?(): string };
    /** Android: Settings → Floating bubble (MainActivity.kt BubbleBridge). */
    JournalBubble?: { enabled(): boolean; canDraw(): boolean; setEnabled(on: boolean): boolean };
  }
}

interface SharePayload {
  quickNote: boolean;
  /** Opened from the bubble's 🎙: start a voice note. */
  voice?: boolean;
  text?: string;
  files: { name: string; mime: string; data: string }[];
  skipped: string[];
}

export interface ShareResult {
  quickNote: boolean;
  voice: boolean;
  added: number;
  skipped: string[];
}

/** Takes whatever was shared into the app (if anything) and adds it to the end of `day`'s note. */
export async function takeShare(store: JournalStore, day: string): Promise<ShareResult | null> {
  const raw = window.JournalShare?.take();
  // Notes typed in the floating bubble, each with the time it was written.
  const notes = JSON.parse(window.JournalShare?.takeNotes?.() || "[]") as { text: string; at: number }[];
  if (!raw && !notes.length) return null;
  const share: SharePayload = raw ? JSON.parse(raw) : { quickNote: false, files: [], skipped: [] };
  const blocks = share.text ? textBlocks(share.text) : [];
  for (const n of notes) {
    // A link on its own (e.g. a YouTube video) becomes a link card, with the time above it.
    if (isLoneUrl(n.text)) blocks.push(...textBlocks(formatTimestamp(new Date(n.at))), { type: "linkCard", attrs: { url: n.text.trim() } });
    else blocks.push(...textBlocks(`${formatTimestamp(new Date(n.at))} ${n.text}`));
  }
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
  return { quickNote: share.quickNote, voice: !!share.voice, added: share.files.length + (share.text ? 1 : 0) + notes.length, skipped: share.skipped };
}

/** A quick note (Mac bubble) added to the end of `day`: with its time; a link on its own becomes a link card. */
export async function appendQuickNote(store: JournalStore, day: string, text: string, at: number) {
  const time = formatTimestamp(new Date(at));
  const blocks = isLoneUrl(text) ? [...textBlocks(time), { type: "linkCard", attrs: { url: text.trim() } }] : textBlocks(`${time} ${text}`);
  const page = await store.getDay(day);
  const content = appendBlocks(page?.content ?? null, blocks);
  await store.saveDay({ day, content, plainText: docText(content) });
}
