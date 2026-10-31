import { describe, expect, it } from "vitest";
import type { JournalEvent } from "../store/types";
import { restoreMerged } from "./repairMerge";

const p = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
const card = (url: string) => ({ type: "linkCard", attrs: { url, title: url, site: null, image: null, status: "ready" } });
const doc = (...content: object[]) => ({ type: "doc", content });
let n = 0;
const ev = (actor: string, before: object | null, after: object): JournalEvent => ({
  id: `e${++n}`, deviceId: "mac", actor, blockId: "b", op: "update", before: before && JSON.stringify(before), after: JSON.stringify(after), parentEventIds: [], createdAt: `2026-10-31T10:0${n}:00Z`,
});

describe("restoreMerged", () => {
  it("puts back cards a merge dropped, after the block they followed", () => {
    const mac = doc(p("Claude"), card("a"), card("b"));
    const merged = doc(p("Claude"), card("phone"));
    const events = [ev("me", doc(p("Claude")), mac), ev("sync", mac, merged)];
    const fixed = restoreMerged(events, merged)!;
    expect(fixed.restored.sort()).toEqual(["link:a", "link:b"]);
    expect(fixed.content.content!.map((x) => x.attrs?.url ?? "p")).toEqual(["p", "a", "b", "phone"]);
  });

  it("leaves cards deleted on purpose", () => {
    const a = doc(p("x"), card("a"));
    const events = [ev("me", null, a), ev("me", a, doc(p("x")))];
    expect(restoreMerged(events, doc(p("x")))).toBeNull();
  });
});
