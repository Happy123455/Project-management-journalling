import { describe, expect, it } from "vitest";
import { effectOf, effectText, monthEvents, waves, writingPeaks } from "./monthEvents";
import { festivalsOn } from "../lib/specialDates";

const at = (day: string, h = 18) => new Date(`${day}T${String(h).padStart(2, "0")}:00:00`).getTime();

describe("month events", () => {
  it("finds deadlines, milestones, holidays and writing peaks", () => {
    const counts: Record<string, number> = { "2026-11-02": 100, "2026-11-03": 120, "2026-11-04": 90, "2026-11-05": 900, "2026-11-06": 110 };
    const ev = monthEvents("2026-11", counts, "2026-11-16", [
      { title: "Essay", emoji: "📝", color: "#123456", endAt: at("2026-11-20"), start: "2026-11-10", steps: [{ text: "Draft", at: at("2026-11-14") }] },
      { title: "Old", emoji: "⏳", color: "#000", endAt: at("2026-11-12"), status: "archived", steps: [] },
    ], (d) => festivalsOn(d));
    expect(ev.map((e) => [e.day, e.kind])).toEqual([
      ["2026-11-05", "writing"],
      ["2026-11-08", "festival"],
      ["2026-11-10", "start"],
      ["2026-11-10", "festival"],
      ["2026-11-14", "milestone"],
      ["2026-11-20", "due"],
    ]);
    expect(ev.find((e) => e.kind === "due")).toMatchObject({ emoji: "🏁", label: "Essay due", effect: null });
  });

  it("writing peaks need 300 words and twice the median", () => {
    expect(writingPeaks("2026-11", { "2026-11-01": 200, "2026-11-02": 200, "2026-11-03": 250, "2026-11-04": 450 }, "2026-11-16")).toEqual([]);
    expect(writingPeaks("2026-11", { "2026-11-01": 100, "2026-11-02": 120, "2026-11-03": 110, "2026-11-04": 400, "2026-11-30": 5000 }, "2026-11-16")).toEqual(["2026-11-04"]);
  });

  it("measures the week after against the week before", () => {
    const counts: Record<string, number> = {};
    for (let i = 1; i <= 7; i++) counts[`2026-10-${String(i).padStart(2, "0")}`] = 100;
    for (let i = 9; i <= 15; i++) counts[`2026-10-${String(i).padStart(2, "0")}`] = 200;
    expect(effectOf("2026-10-08", counts, "2026-11-16")).toBe(1);
    expect(effectText(1)).toBe("+100% writing after");
    expect(effectText(-0.25)).toBe("−25% writing after");
    // Not enough days after yet.
    expect(effectOf("2026-11-15", counts, "2026-11-16")).toBeNull();
  });

  it("waves spread over the following days, fading, within the month", () => {
    const w = waves([{ day: "2026-11-27", kind: "due", emoji: "🏁", label: "x", effect: null }], "2026-11");
    expect(w.get("2026-11-27")).toMatchObject({ source: true, delay: 0, strength: 1 });
    expect(w.get("2026-11-28")!.delay).toBeLessThan(w.get("2026-11-30")!.delay);
    expect(w.get("2026-11-28")!.strength).toBeGreaterThan(w.get("2026-11-30")!.strength);
    expect(w.has("2026-12-01")).toBe(false);
  });
});
