import { describe, expect, it } from "vitest";
import { MemoryStore } from "./memoryStore";

const doc = (text: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });

describe("MemoryStore", () => {
  it("creates a day page and logs a create event", async () => {
    const store = new MemoryStore(undefined, "laptop");
    const page = await store.saveDay({ day: "2026-10-28", content: doc("hi"), plainText: "hi" });
    expect(await store.getDay("2026-10-28")).toEqual(page);
    const events = await store.eventsFor(page.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ op: "create", deviceId: "laptop", parentEventIds: [] });
  });

  it("chains update events and skips saves with no change", async () => {
    const store = new MemoryStore(undefined, "laptop");
    const page = await store.saveDay({ day: "2026-10-28", content: doc("a"), plainText: "a" });
    await store.saveDay({ day: "2026-10-28", content: doc("b"), plainText: "b" });
    await store.saveDay({ day: "2026-10-28", content: doc("b"), plainText: "b" });
    const [first, second] = await store.eventsFor(page.id);
    expect(await store.eventsFor(page.id)).toHaveLength(2);
    expect(second.parentEventIds).toEqual([first.id]);
  });

  it("persists through storage", async () => {
    const mem = new Map<string, string>();
    const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    await new MemoryStore(storage, "phone").saveDay({ day: "2026-10-27", content: doc("x"), plainText: "x" });
    expect(await new MemoryStore(storage, "phone").listDays()).toEqual(["2026-10-27"]);
  });
});
