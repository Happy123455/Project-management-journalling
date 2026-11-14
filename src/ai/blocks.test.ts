import { describe, expect, it } from "vitest";
import { applyBlockOp, blockRows, numbered, type Section } from "./blocks";
import { parseToolCalls } from "./agent";

const p = (lid: string, text: string) => ({ type: "paragraph", attrs: { lid }, content: [{ type: "text", text }] });
const doc = { type: "doc", content: [p("a", "intro"), { type: "heading", attrs: { lid: "b", level: 2 }, content: [{ type: "text", text: "Plans" }] }, p("c", "gym"), p("d", "outro")] };
const section: Section = { day: "2026-11-09", ids: ["b", "c"], label: "Plans" };

describe("AI section editing", () => {
  it("numbers only the section", () => {
    expect(numbered(doc, section)).toBe("[1] # Plans\n[2] gym");
    expect(blockRows(doc).map((r) => r.id)).toEqual(["a", "b", "c", "d"]);
  });
  it("edits inside the section and refuses outside it", () => {
    const r = applyBlockOp(doc, { op: "replace", n: 2, text: "gym at 7\nthen swim" }, section);
    if (typeof r === "string") throw new Error(r);
    expect(blockRows(r.doc).map((x) => x.text)).toEqual(["intro", "Plans", "gym at 7", "then swim", "outro"]);
    expect(r.section?.ids.length).toBe(3);
    expect(applyBlockOp(doc, { op: "delete", n: 3 }, section)).toMatch(/doesn't exist in the section/);
    const h = applyBlockOp(doc, { op: "replace", n: 1, text: "Goals" }, section);
    if (typeof h === "string") throw new Error(h);
    expect(h.doc.content?.[1]).toMatchObject({ type: "heading", attrs: { lid: "b", level: 2 } });
  });
  it("inserts before the first and deletes", () => {
    const r = applyBlockOp(doc, { op: "insert_after", n: 0, text: "## New" }, section);
    if (typeof r === "string") throw new Error(r);
    expect(r.doc.content?.[1].type).toBe("heading");
    const d = applyBlockOp(doc, { op: "delete", n: 1 }, null);
    if (typeof d === "string") throw new Error(d);
    expect(blockRows(d.doc).map((x) => x.text)).toEqual(["Plans", "gym", "outro"]);
  });
  it("tells the model about a broken call", () => {
    expect(parseToolCalls("<tool_call>{oops</tool_call>").calls[0].error).toMatch(/valid JSON/);
  });
});
