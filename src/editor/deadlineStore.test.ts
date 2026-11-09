// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { Editor, Node } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { barsOf, deleteDeadline, plansIn, retime, writeBack } from "./deadlineStore";

const ATTRS = ["tid", "day", "endAt", "title", "first", "plans", "comments", "color"];
const Bar = Node.create({
  name: "deadlineBar",
  group: "block",
  atom: true,
  addAttributes: () => Object.fromEntries(ATTRS.map((a) => [a, { default: null }])),
  renderHTML: () => ["div"],
});
const at = (day: string, h: number) => new Date(`${day}T${String(h).padStart(2, "0")}:00:00`).getTime();
const bar = (day: string, first = false, plans: unknown[] = []) => ({ type: "deadlineBar", attrs: { tid: "t", day, endAt: at("2026-11-11", 18), title: "ESD2", first, plans, comments: [], color: "#8a5cff" } });
const p = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });

function make() {
  const late = { id: "late", start: at("2026-11-11", 10), end: at("2026-11-11", 11), text: "late" };
  return new Editor({
    extensions: [StarterKit, Bar],
    content: { type: "doc", content: [p("top"), bar("2026-11-09", true), p("mon notes"), bar("2026-11-10"), { type: "paragraph" }, bar("2026-11-11", false, [late]), p("end")] },
  });
}

describe("changing a deadline in its note", () => {
  it("moves the due time earlier: days after it go, their plans and the writing stay", () => {
    const e = make();
    retime(e, "t", at("2026-11-10", 12));
    expect(barsOf(e, "t").map((b) => [b.attrs.day, b.attrs.endAt, b.attrs.first, b.attrs.color])).toEqual([
      ["2026-11-09", at("2026-11-10", 12), true, "#8a5cff"],
      ["2026-11-10", at("2026-11-10", 12), false, "#8a5cff"],
    ]);
    expect(plansIn(e, "t").map((x) => x.id)).toEqual(["late"]);
    expect(e.getText()).toContain("mon notes");
    expect(e.getText()).toContain("end");
  });

  it("moves it later: new days are added after the last one, in order", () => {
    const e = make();
    retime(e, "t", at("2026-11-13", 9));
    expect(barsOf(e, "t").map((b) => b.attrs.day)).toEqual(["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13"]);
    expect(plansIn(e, "t").map((x) => x.id)).toEqual(["late"]);
  });

  it("puts plans on the bar of the day they start, and delete can be undone", () => {
    const e = make();
    writeBack(e, "t", "plans", [{ id: "a", start: at("2026-11-10", 9), end: at("2026-11-10", 10), text: "a" }, { id: "b", start: at("2026-11-20", 9), end: at("2026-11-20", 10), text: "b" }]);
    expect(barsOf(e, "t").map((b) => (b.attrs.plans as { id: string }[]).map((x) => x.id))).toEqual([[], ["a"], ["b"]]);
    deleteDeadline(e, "t", "ESD2");
    expect(barsOf(e, "t")).toEqual([]);
    e.commands.undo();
    expect(barsOf(e, "t").length).toBe(3);
  });
});
