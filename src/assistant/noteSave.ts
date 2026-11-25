// Reading and saving the note an assistant tool works on, and bringing it on screen first so the
// edit (and its swarm) plays where it can be seen (25 Nov, Hapi: "if it's editing something, I
// want to be in that note and see it").
import type { JSONContent } from "@tiptap/core";
import { AI_OPEN_EVENT } from "../ai/journalTools";
import { openDayEditor as dayEd, openPageEditor } from "../editor/noteEdit";
import { dayKey } from "../lib/timestamp";
import { docText } from "../lib/words";
import type { JournalStore } from "../store";

export interface NoteCtx {
  store: JournalStore;
  actor: string;
  now: Date;
}

export interface Note {
  name: string;
  doc: JSONContent | null;
  save: (doc: JSONContent) => Promise<unknown>;
}
export async function noteFor(ctx: NoteCtx, a: Record<string, unknown>): Promise<Note | string> {
  const title = typeof a.title === "string" ? a.title.trim() : "";
  if (title) {
    const page = await ctx.store.getPage(title);
    if (!page) return `No page called "${title}".`;
    return { name: page.title, doc: page.content, save: (doc) => ctx.store.savePage({ id: page.id, content: doc, plainText: docText(doc), actor: ctx.actor }) };
  }
  const day = typeof a.date === "string" && a.date ? (a.date === "today" ? dayKey(ctx.now) : a.date) : dayKey(ctx.now);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return "date must be YYYY-MM-DD";
  const page = await ctx.store.getDay(day);
  return { name: day, doc: page?.content ?? null, save: (doc) => ctx.store.saveDay({ day, content: doc, plainText: docText(doc), actor: ctx.actor }) };
}

/**
 * Hapi, 25 Nov: "if it's editing something, I want to be in that note and see it". A note that isn't
 * on screen is opened first, the way a person would (Home / week / month / year, navShow.ts), so the
 * edit and its swarm play where Hapi can see them.
 */
export async function bringIntoView(name: string) {
  const isDay = /^\d{4}-\d{2}-\d{2}$/.test(name);
  // Only in the app itself (tests and the MCP server have no screen to show it on).
  if (typeof document === "undefined" || !document.querySelector(".nav-island, .month-calendar, .journal-editor")) return;
  if (isDay ? dayEd(name) : openPageEditor(name)) return;
  await new Promise<void>((r) => {
    let over = false;
    const done = () => !over && ((over = true), window.setTimeout(r, 300));
    window.dispatchEvent(new CustomEvent(AI_OPEN_EVENT, { detail: { target: name, newTab: false, now: true, show: true, done } }));
    window.setTimeout(done, 12_000);
  });
}

/** Saves a note the assistant changed and shows it as it is now. */
export async function saved(note: Note, doc: JSONContent, said: string) {
  await bringIntoView(note.name).catch(() => {});
  await window.__journalFlush?.();
  await note.save(doc);
  window.dispatchEvent(new Event("journal:reload-page"));
  return said;
}

