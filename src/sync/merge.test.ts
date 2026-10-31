import { describe, expect, it } from "vitest";
import type { JournalEvent } from "../store/types";
import { fromLines, planMerge, toLines, type LocalState, type SyncRecord, mergeDocs } from "./merge";

const day = { kind: "block", type: "day", day: "2026-10-28" } as const;

function rec(id: string, device: string, at: string, op: JournalEvent["op"], after: string, block = "b1", parents: string[] = []): SyncRecord {
  return {
    event: { id, deviceId: device, actor: "me", blockId: block, op, before: null, after, parentEventIds: parents, createdAt: at },
    meta: day,
  };
}

const empty = (): LocalState => ({ eventIds: new Set(), latest: new Map(), fileIds: new Set() });

describe("planMerge", () => {
  it("creates a block another device wrote", () => {
    const plan = planMerge(empty(), [rec("e1", "phone", "2026-10-28T10:00:00Z", "create", "A")]);
    expect(plan.events.map((r) => r.event.id)).toEqual(["e1"]);
    expect(plan.blocks).toEqual([{ blockId: "b1", meta: day, content: "A", props: undefined, updatedAt: "2026-10-28T10:00:00Z" }]);
  });

  it("two devices edit the same block: the later edit wins, both stay in the log", () => {
    const local: LocalState = {
      eventIds: new Set(["m1", "m2"]),
      latest: new Map([["b1", { content: ["2026-10-28T10:05:00Z", "mac", "m2"], props: null }]]),
      fileIds: new Set(),
    };
    // The phone edited earlier than the Mac's latest edit: kept in history, not applied.
    const older = planMerge(local, [rec("p1", "phone", "2026-10-28T10:03:00Z", "update", "phone text", "b1", ["m1"])]);
    expect(older.events.map((r) => r.event.id)).toEqual(["p1"]);
    expect(older.events[0].event.parentEventIds).toEqual(["m1"]);
    expect(older.blocks).toEqual([]);
    // A later phone edit replaces the Mac's.
    const newer = planMerge(local, [rec("p2", "phone", "2026-10-28T10:09:00Z", "update", "phone wins")]);
    expect(newer.blocks[0].content).toBe("phone wins");
  });

  it("breaks exact time ties by device id, the same way on every device", () => {
    const at = "2026-10-28T10:00:00Z";
    const plan = planMerge(empty(), [rec("x", "phone", at, "update", "from phone"), rec("y", "mac", at, "update", "from mac")]);
    expect(plan.blocks[0].content).toBe("from phone"); // "phone" > "mac"
  });

  it("ignores events it already has, so importing twice changes nothing", () => {
    const records = [rec("e1", "phone", "2026-10-28T10:00:00Z", "create", "A"), rec("e1", "phone", "2026-10-28T10:00:00Z", "create", "A")];
    const first = planMerge(empty(), records);
    expect(first.events).toHaveLength(1);
    const after: LocalState = { eventIds: new Set(["e1"]), latest: new Map([["b1", { content: ["2026-10-28T10:00:00Z", "phone", "e1"], props: null }]]), fileIds: new Set() };
    expect(planMerge(after, records)).toEqual({ events: [], blocks: [], files: [] });
  });

  it("handles files read out of order: the newest edit wins whatever order they arrive in", () => {
    const a = rec("e1", "phone", "2026-10-28T09:00:00Z", "create", "first");
    const b = rec("e2", "phone", "2026-10-28T11:00:00Z", "update", "last");
    const c = rec("e3", "tablet", "2026-10-28T10:00:00Z", "update", "middle");
    for (const order of [[a, b, c], [c, b, a], [b, a, c]]) {
      const plan = planMerge(empty(), order);
      expect(plan.blocks[0].content).toBe("last");
      expect(plan.events.map((r) => r.event.id)).toEqual(["e1", "e3", "e2"]);
    }
  });

  it("merges content and reminder flags separately", () => {
    const local: LocalState = { eventIds: new Set(), latest: new Map([["b1", { content: ["2026-10-28T12:00:00Z", "mac", "m9"], props: null }]]), fileIds: new Set() };
    const plan = planMerge(local, [rec("p1", "phone", "2026-10-28T11:00:00Z", "props", '{"reminder":true,"reminderDone":true}')]);
    expect(plan.blocks).toEqual([{ blockId: "b1", meta: day, content: undefined, props: '{"reminder":true,"reminderDone":true}', updatedAt: "2026-10-28T11:00:00Z" }]);
  });

  it("asks for files it doesn't have, once, and never re-imports a restore", () => {
    const file = { id: "f1", name: "a.png", mime: "image/png", size: 1, hash: "h1", path: "attachments/f1/a.png", createdAt: "x" };
    const fileRec: SyncRecord = { event: { ...rec("e5", "phone", "2026-10-28T10:00:00Z", "create", "{}", "f1").event }, meta: { kind: "file", file } };
    const restore = rec("e6", "phone", "2026-10-28T10:01:00Z", "restore", "{}", "journal");
    const plan = planMerge(empty(), [fileRec, fileRec, restore]);
    expect(plan.files).toEqual([file]);
    expect(plan.events.map((r) => r.event.id)).toEqual(["e5"]);
    expect(planMerge({ ...empty(), fileIds: new Set(["f1"]) }, [fileRec]).files).toEqual([]);
  });
});

describe("sync files", () => {
  it("round-trips records and skips a half-written last line", () => {
    const records = [rec("e1", "phone", "2026-10-28T10:00:00Z", "create", "A")];
    const text = toLines(records) + '{"event":{"id":"e2"';
    expect(fromLines(text)).toEqual(records);
  });
});

describe("mergeDocs", () => {
  const p = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
  const clip = (width: number) => ({ type: "paragraph", content: [{ type: "attachmentMedia", attrs: { fileId: "facepalm", width } }] });
  const doc = (...content: object[]) => ({ type: "doc", content });

  it("never adds a clip back as a copy because it was resized on the other device", () => {
    const merged = mergeDocs(doc(p("a"), clip(165)), doc(p("a"), clip(210)));
    expect(merged.content).toEqual([p("a"), clip(165)]);
  });

  it("keeps a deletion from the older side when both had the block before", () => {
    const base = doc(p("a"), clip(210), p("b"));
    const merged = mergeDocs(doc(p("a"), clip(210), p("b"), p("new")), doc(p("a"), p("b")), base);
    expect(merged.content).toEqual([p("a"), p("b"), p("new")]);
  });

  it("takes an edit from the older side instead of keeping both versions", () => {
    const base = doc(p("a"), p("b"));
    const merged = mergeDocs(doc(p("a"), p("b"), p("c")), doc(p("a"), p("b edited")), base);
    expect(merged.content).toEqual([p("a"), p("b edited"), p("c")]);
  });

  it("still keeps text both sides wrote without a common version", () => {
    const merged = mergeDocs(doc(p("a"), p("mine")), doc(p("a"), p("theirs")));
    expect(merged.content).toEqual([p("a"), p("theirs"), p("mine")]);
  });
});

describe("mergeDocs lists", () => {
  const item = (t: string) => ({ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: t }] }] });
  const list = (...items: string[]) => ({ type: "bulletList", content: items.map(item) });
  const doc = (...content: object[]) => ({ type: "doc", content });

  it("a point moved on one device and one added on the other: one list, no copies", () => {
    const base = doc(list("a", "b", "c"));
    const merged = mergeDocs(doc(list("a", "b", "c", "d")), doc(list("c", "a", "b")), base);
    expect(merged.content).toHaveLength(1);
    const texts = (merged.content![0].content ?? []).map((i) => i.content![0].content![0].text);
    expect(texts.sort()).toEqual(["a", "b", "c", "d"]);
  });
});

describe("mergeDocs keeps every link card and photo (31 Oct)", () => {
  const card = (url: string, status = "ready") => ({ type: "linkCard", attrs: { url, title: url, site: null, image: null, status } });
  const p = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
  const img = (fileId: string, width: number | null = null) => ({ type: "paragraph", content: [{ type: "attachmentImage", attrs: { fileId, name: "x", width, align: "inline", x: 0, y: 0 } }] });

  it("links added on one device survive a merge with a doc that has another link", () => {
    const base = { type: "doc", content: [p("Claude")] };
    const mac = { type: "doc", content: [p("Claude"), card("https://a.dev"), card("https://b.dev"), card("https://c.dev")] };
    const phone = { type: "doc", content: [p("Claude"), card("https://phone.dev"), p("later")] };
    const both = mergeDocs(phone, mac, base);
    const urls = both.content!.filter((n) => n.type === "linkCard").map((n) => n.attrs!.url);
    expect(urls.sort()).toEqual(["https://a.dev", "https://b.dev", "https://c.dev", "https://phone.dev"]);
  });

  it("a card whose preview loaded on one side is still one card", () => {
    const both = mergeDocs({ type: "doc", content: [card("https://a.dev", "ready")] }, { type: "doc", content: [card("https://a.dev", "loading")] });
    expect(both.content).toHaveLength(1);
  });

  it("different photos are kept, a resized photo is not doubled", () => {
    const both = mergeDocs({ type: "doc", content: [img("f1", 200)] }, { type: "doc", content: [img("f1", 300), img("f2")] });
    expect(both.content!.map((n) => n.content![0].attrs!.fileId)).toEqual(["f1", "f2"]);
  });
});
