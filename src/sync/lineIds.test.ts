// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import type { JSONContent } from "@tiptap/react";
import { LineIds } from "../editor/lineIds";
import { merge3, mergeDocs } from "./merge";
import { withLineIds } from "./lineIds";

const p = (text: string, lid?: string): JSONContent => ({ type: "paragraph", ...(lid ? { attrs: { lid } } : {}), content: text ? [{ type: "text", text }] : undefined });
const doc = (...content: JSONContent[]): JSONContent => ({ type: "doc", content });
const texts = (d: JSONContent) => (d.content ?? []).map((n) => n.content?.[0]?.text ?? "");
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("line ids keep one line one line", () => {
  it("half-typed versions of a line from the other device don't become extra lines", () => {
    const base = doc(p("Today", "a"), p("Hel", "x"));
    const phone = doc(p("Today", "a"), p("Hello world", "x"));
    const mac = doc(p("Today", "a"), p("Hello wo", "x"));
    expect(texts(mergeDocs(phone, mac, base))).toEqual(["Today", "Hello world"]);
    expect(texts(mergeDocs(mac, phone, base))).toEqual(["Today", "Hello world"]);
    expect(texts(mergeDocs(phone, mac))).toEqual(["Today", "Hello world"]);
  });

  it("new lines written on both devices are both kept, deletions stay deleted", () => {
    const base = doc(p("one", "a"), p("two", "b"), p("three", "c"));
    const phone = doc(p("one", "a"), p("phone line", "p"), p("three", "c"));
    const mac = doc(p("one", "a"), p("two", "b"), p("three", "c"), p("mac line", "m"));
    expect(texts(mergeDocs(phone, mac, base))).toEqual(["one", "phone line", "three", "mac line"]);
  });

  it("both edited different parts of one line: both edits", () => {
    expect(merge3("I went to town", "I went to the town", "I walked to town")).toBe("I walked to the town");
    const base = doc(p("I went to town", "x"));
    const r = mergeDocs(doc(p("I went to the town", "x")), doc(p("I walked to town", "x")), base);
    expect(texts(r)).toEqual(["I walked to the town"]);
  });

  it("the same old line gets the same id on both devices", () => {
    const a = withLineIds(doc(p("one"), p(""), p("")));
    const b = withLineIds(doc(p("one"), p(""), p("")));
    expect(a).toEqual(b);
    const ids = a.content!.map((n) => n.attrs!.lid);
    expect(new Set(ids).size).toBe(3);
  });

  it("the editor gives old lines content ids and new lines their own", async () => {
    const ed = new Editor({ extensions: [StarterKit, LineIds], content: "<p>one</p><ul><li><p>item</p></li></ul>" });
    await tick();
    const json = ed.getJSON();
    expect(json).toEqual(withLineIds(json));
    expect(json.content![0].attrs!.lid).toBe(withLineIds(doc(p("one"), json.content![1])).content![0].attrs!.lid);
    ed.commands.setTextSelection(4);
    ed.commands.splitBlock();
    ed.commands.insertContent("two");
    const ids = ed.getJSON().content!.map((n) => n.attrs!.lid);
    expect(ids[0]).toBe(json.content![0].attrs!.lid);
    expect(ids[1]).toMatch(/^r/);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("sync files carry only what changed", () => {
  it("a run of edits to one note packs small and reads back exactly", async () => {
    const { toLines, fromLines } = await import("./merge");
    const long = Array.from({ length: 200 }, (_, i) => p(`line ${i} with some words in it`, `l${i}`));
    const versions = ["H", "He", "Hel", "Hello"].map((t) => JSON.stringify(doc(...long, p(t, "x"))));
    const meta = { kind: "block", type: "day", day: "2026-11-07" } as const;
    const records = versions.slice(1).map((after, i) => ({
      event: { id: `e${i}`, deviceId: "phone", actor: "me", blockId: "b", op: "update" as const, before: versions[i], after, parentEventIds: [], createdAt: `2026-11-07T00:00:0${i}Z` },
      meta,
    }));
    const packed = toLines(records);
    const plain = records.map((r) => JSON.stringify(r)).join("\n");
    expect(packed.length).toBeLessThan(plain.length / 2.5);
    expect(fromLines(packed)).toEqual(records);
  });
});
