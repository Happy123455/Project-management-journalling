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

describe("deadlines as data", () => {
  it("reads settings and rings plans and due times", async () => {
    const { deadlineAlarms } = await import("./deadlineStore");
    const now = Date.parse("2026-11-09T08:00:00");
    const end = Date.parse("2026-11-11T18:00:00");
    const plan = { id: "p1", start: Date.parse("2026-11-09T10:00:00"), end: Date.parse("2026-11-09T11:00:00"), text: "Draft" };
    const doc = { type: "doc", content: [{ type: "deadlineBar", attrs: { tid: "t1", day: "2026-11-09", endAt: end, title: "ESD2", first: true, emoji: "📚", remind: 15, plans: [plan], comments: [] } }] };
    const [t] = timelinesIn(doc, "2026-11-09");
    expect(t.info).toMatchObject({ emoji: "📚", remind: 15 });
    const alarms = deadlineAlarms([t], now);
    expect(alarms.map((a) => [a.title, new Date(a.at).toTimeString().slice(0, 5)])).toEqual([
      ["Draft in 15 min", "09:45"],
      ["📚 ESD2 is due tomorrow", "18:00"],
      ["📚 ESD2 is due in 1 hour", "17:00"],
    ]);
    expect(deadlineAlarms([{ ...t, info: { ...t.info, status: "done" } }], now)).toEqual([]);
  });
});
