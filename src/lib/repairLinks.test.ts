import { describe, expect, it } from "vitest";
import { MemoryStore } from "../store/memoryStore";
import { textBlocks } from "./append";
import { repairLostLinks } from "./repairLinks";
import { docText } from "./words";

const doc = (...lines: string[]) => ({ type: "doc", content: lines.flatMap((l) => textBlocks(l)) });
const save = (store: MemoryStore, ...lines: string[]) => {
  const content = doc(...lines);
  return store.saveDay({ day: "2026-10-28", content, plainText: docText(content) });
};

describe("wikilinks", () => {
  it("are still there after opening the linked page and coming back", async () => {
    const store = new MemoryStore();
    await save(store, "Met [[Alice]] today");
    await store.ensurePage("Alice");
    expect(docText((await store.getDay("2026-10-28"))!.content)).toContain("[[Alice]]");
  });

  it("lost to a stale save are restored as a repair event", async () => {
    const store = new MemoryStore();
    await save(store, "Morning");
    await save(store, "Morning", "Met [[Alice]] at the cafe");
    // The bug: the day came back from the first copy and the next keystroke saved over it.
    await save(store, "Morning", "Evening");
    const report = await repairLostLinks(store);
    expect(report).toEqual([expect.objectContaining({ day: "2026-10-28", links: ["[[Alice]]"], blocks: 1 })]);
    const page = (await store.getDay("2026-10-28"))!;
    expect(docText(page.content)).toMatch(/Evening[\s\S]*Restored[\s\S]*Met \[\[Alice\]\] at the cafe/);
    const events = await store.eventsFor(page.id);
    expect(events[events.length - 1].actor).toBe("repair");
    // Nothing more to do the second time.
    expect(await repairLostLinks(store)).toEqual([]);
  });

  it("deleted on purpose and then re-added elsewhere are left alone", async () => {
    const store = new MemoryStore();
    await save(store, "Met [[Alice]]");
    await save(store, "Saw [[Alice]] again");
    expect(await repairLostLinks(store)).toEqual([]);
  });
});
