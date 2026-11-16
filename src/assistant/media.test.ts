// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryStore } from "../store/memoryStore";
import { runAssistantTool, type RunCtx } from "./tools";

const now = new Date(2026, 10, 16, 10, 0);
const ctx = (store: MemoryStore): RunCtx => ({ store, actor: "Assistant", now, touched: new Set(), found: [], opened: [] });
const nodesOf = (doc: unknown): { type: string; attrs?: Record<string, unknown> }[] => {
  const out: { type: string; attrs?: Record<string, unknown> }[] = [];
  const walk = (n: { type?: string; attrs?: Record<string, unknown>; content?: unknown[] }) => {
    if (n.type) out.push({ type: n.type, attrs: n.attrs });
    (n.content ?? []).forEach((c) => walk(c as never));
  };
  walk(doc as never);
  return out;
};

afterEach(() => {
  vi.unstubAllGlobals();
  delete window.JournalPhotos;
});

describe("assistant media", () => {
  it("adds the newest journal photo as a real image block, not markdown", async () => {
    const store = new MemoryStore();
    await store.saveFile({ name: "old.jpg", mime: "image/jpeg", bytes: new Uint8Array([1]) });
    await new Promise((r) => setTimeout(r, 5));
    const fresh = await store.saveFile({ name: "20261029_142627.jpg", mime: "image/jpeg", bytes: new Uint8Array([2]) });
    const r = await runAssistantTool({ name: "add_media", arguments: { source: "journal", kind: "photo" } }, ctx(store));
    expect(r.bad).toBe(false);
    const img = nodesOf((await store.getDay("2026-11-16"))!.content).find((n) => n.type === "attachmentImage");
    expect(img?.attrs?.fileId).toBe(fresh.id);
  });

  it("finds a meme in the kit and saves it as a meme file", async () => {
    const index = [{ id: "photo:this-is-fine", kind: "photo", name: "This is fine (dog)", file: "photos/this-is-fine.png", tags: ["Reactions"] }, { id: "sound:bruh", kind: "sound", name: "Bruh", file: "sounds/bruh.mp3" }];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (url.endsWith("index.json") ? new Response(JSON.stringify(index)) : new Response(new Blob([new Uint8Array([9])], { type: "image/png" })))));
    const store = new MemoryStore();
    const c = ctx(store);
    const found = await runAssistantTool({ name: "find_media", arguments: { source: "memes", query: "this is fine" } }, c);
    expect(found.out).toContain("1. This is fine (dog) (photo, memes)");
    const r = await runAssistantTool({ name: "add_media", arguments: { n: 1 } }, c);
    expect(r.bad).toBe(false);
    const files = await store.listFiles();
    expect(files[0].name).toBe("meme-this-is-fine-dog-.png");
    expect(nodesOf((await store.getDay("2026-11-16"))!.content).some((n) => n.type === "attachmentImage" && n.attrs?.fileId === files[0].id)).toBe(true);
  });

  it("adds the latest phone photo from the gallery", async () => {
    window.JournalPhotos = {
      granted: () => true,
      recent: (id) => setTimeout(() => window.__journalPhotos?.(id, JSON.stringify({ items: [{ uri: "content://media/1", name: "IMG_1.jpg", mime: "image/jpeg", size: 3, taken: now.getTime() - 60000 }] }))),
      read: (id) => setTimeout(() => window.__journalPhotos?.(id, JSON.stringify({ mime: "image/jpeg", data: btoa("abc") }))),
    };
    const store = new MemoryStore();
    const r = await runAssistantTool({ name: "add_media", arguments: { source: "phone" } }, ctx(store));
    expect(r.out).toContain("IMG_1.jpg");
    const files = await store.listFiles();
    expect(Array.from((await store.fileBytes(files[0].id))!)).toEqual([97, 98, 99]);
  });

  it("says why on the Mac, where there is no phone gallery", async () => {
    const r = await runAssistantTool({ name: "add_media", arguments: { source: "phone" } }, ctx(new MemoryStore()));
    expect(r.bad).toBe(true);
    expect(r.out).toContain("only be read in the app on the phone");
  });
});
