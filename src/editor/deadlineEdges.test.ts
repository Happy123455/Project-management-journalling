// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { DeadlineBar } from "./deadlineBar";
import { setAll } from "./deadlineStore";
import type { DecorationSet } from "@tiptap/pm/view";

describe("deadline top edge", () => {
  it("keeps a skip of days above the first shown, saved on the bars", () => {
    const days = ["2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19"];
    const content = days.map((day, i) => ({ type: "deadlineBar", attrs: { tid: "t1", day, first: i === 0, endAt: Date.parse("2026-11-19T18:00:00") } }));
    const e = new Editor({ extensions: [StarterKit, DeadlineBar], content: { type: "doc", content } });
    setAll(e, "t1", { skip: 2, show: 0 });
    const attrs: { skip: number; show: number }[] = [];
    e.state.doc.forEach((n) => n.type.name === "deadlineBar" && attrs.push({ skip: n.attrs.skip, show: n.attrs.show }));
    expect(attrs.every((x) => x.skip === 2 && x.show === 0)).toBe(true);
    // The fold plugin hides the first two bars.
    const decos = e.view.someProp("decorations", (f) => f(e.state)) as DecorationSet | undefined;
    const hidden: number[] = [];
    decos?.find().forEach((d) => (d as unknown as { type: { attrs?: { class?: string } } }).type.attrs?.class === "dl-fold" && hidden.push(d.from));
    const pos: number[] = [];
    e.state.doc.forEach((n, p) => n.type.name === "deadlineBar" && pos.push(p));
    expect([...new Set(hidden.filter((h) => pos.includes(h)))]).toEqual(pos.slice(0, 2));
    e.destroy();
  });
});
