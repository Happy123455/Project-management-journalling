import { describe, expect, it } from "vitest";
import { timelinesIn } from "./TimelinesView";

const bar = (day: string, first = false) => ({ type: "deadlineBar", attrs: { tid: "t1", day, endAt: 1, title: "ESD2", first, comments: [], plans: [] } });
const p = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });

describe("timelines in a note", () => {
  it("collects a deadline's days and the text written between them", () => {
    const doc = { type: "doc", content: [p("before"), bar("2026-11-08", true), p("call Raj"), { type: "paragraph" }, bar("2026-11-09"), bar("2026-11-10"), p("after all")] };
    const [t] = timelinesIn(doc, "2026-11-08");
    expect(t.title).toBe("ESD2");
    expect(t.rows.map((r) => [r.day, r.between])).toEqual([["2026-11-08", ["call Raj"]], ["2026-11-09", []], ["2026-11-10", []]]);
  });
});
