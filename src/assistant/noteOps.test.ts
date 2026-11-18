import { describe, expect, it } from "vitest";
import type { JSONContent } from "@tiptap/core";
import { freshCopy, insertUnder, linesToBlocks, nodeAt, taskBlock, tasksIn, tickTask, topCounts } from "./noteOps";

const p = (text: string, indent = 0): JSONContent => ({ type: "paragraph", attrs: { indent, lid: `l-${text}` }, content: text ? [{ type: "text", text }] : [] });
const h = (text: string, level = 2): JSONContent => ({ type: "heading", attrs: { level }, content: [{ type: "text", text }] });
const task = (text: string, checked = false): JSONContent => ({ type: "taskList", content: [{ type: "taskItem", attrs: { checked, lid: "t1", ed: "pc@1" }, content: [p(text)] }] });
const texts = (d: JSONContent) => (d.content ?? []).map((b) => JSON.stringify(b).match(/"text":"([^"]*)"/)?.[1] ?? "");

describe("assistant note edits", () => {
  it("finds open tasks and copies one without its line id", () => {
    const doc = { type: "doc", content: [p("hi"), task("buy milk"), task("done one", true)] };
    const open = tasksIn("2026-11-10", doc).filter((t) => !t.checked);
    expect(open.map((t) => t.text)).toEqual(["buy milk"]);
    const copy = taskBlock(nodeAt(doc, open[0].path)!);
    expect(JSON.stringify(copy)).not.toMatch(/"lid"|"ed"/);
    expect(copy.content?.[0].attrs?.checked).toBe(false);
    expect(freshCopy(p("x")).attrs).toEqual({ indent: 0 });
  });
  it("puts blocks at the end of a heading's section", () => {
    const doc = { type: "doc", content: [h("Morning"), p("a"), h("📓 Journal"), p("b"), p(""), h("Work"), p("c")] };
    const r = insertUnder(doc, "journal", [p("NEW")]);
    expect(r.found).toBe(true);
    expect(texts(r.doc)).toEqual(["Morning", "a", "📓 Journal", "b", "NEW", "", "Work", "c"]);
  });
  it("puts blocks inside a box line, one level in", () => {
    const doc = { type: "doc", content: [p("[[Journal]]"), p("one", 1), p("after")] };
    const r = insertUnder(doc, "Journal", [p("NEW")]);
    expect(texts(r.doc)).toEqual(["[[Journal]]", "one", "NEW", "after"]);
    expect(r.doc.content?.[2].attrs?.indent).toBe(1);
  });
  it("adds the heading when there's none", () => {
    const r = insertUnder({ type: "doc", content: [p("x"), p("")] }, "Journal", [p("NEW")]);
    expect(r.found).toBe(false);
    expect(texts(r.doc)).toEqual(["x", "Journal", "NEW"]);
  });
  it("ticks a task by its words", () => {
    const doc = { type: "doc", content: [task("call Ravi"), task("buy milk")] };
    const r = tickTask(doc, "milk")!;
    expect(r.task).toBe("buy milk");
    expect(tasksIn("x", r.doc).map((t) => t.checked)).toEqual([false, true]);
    expect(tickTask(doc, "nothing")).toBeNull();
  });
  it("turns lines into blocks and counts", () => {
    const b = linesToBlocks("one\n- [ ] two\n- [x] three");
    expect(b.map((x) => x.type)).toEqual(["paragraph", "taskList", "taskList"]);
    expect(b[2].content?.[0].attrs?.checked).toBe(true);
    expect(topCounts(["a", "b", "a", "c", "a", "b"], 2)).toEqual([["a", 3], ["b", 2]]);
  });
});

import { deleteLines } from "./noteOps";
describe("deleteLines (one deletion, asked once)", () => {
  const p = (t?: string) => ({ type: "paragraph", ...(t ? { content: [{ type: "text", text: t }] } : {}) });
  it("removes the lines and the empty lines around them", () => {
    const doc = { type: "doc", content: [p("Keep me"), p(), p("Old plan one"), p(), p("Old plan two"), p(), p("Keep too")] };
    const r = deleteLines(doc, ["old plan one", "old plan two"]);
    expect(r.removed).toBe(2);
    expect(r.doc.content!.map((b) => b.content?.[0]?.text ?? "")).toEqual(["Keep me", "Keep too"]);
  });
  it("tells what it didn't find", () => {
    const r = deleteLines({ type: "doc", content: [p("a line")] }, ["nope"]);
    expect(r.removed).toBe(0);
    expect(r.missing).toEqual(["nope"]);
  });
});
