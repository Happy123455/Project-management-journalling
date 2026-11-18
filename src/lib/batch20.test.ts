import { describe, expect, it } from "vitest";
import { extractLinks, isLinkTarget } from "./links";
import { mathBlocksIn, setValuesIn, workOut } from "./mathFind";
import { planBlocks, planLines } from "./workPlan";

const at = (h: number, m = 0) => new Date(2026, 10, 17, h, m).getTime();

describe("accidental long links", () => {
  it("keeps names, drops prompts and arrays", () => {
    expect(isLinkTarget("pocket")).toBe(true);
    expect(isLinkTarget("Graph · Journaling prompts")).toBe(true);
    const long = "it won't understand and keep glitching out now and the selection thing appear after it also going out of screen so as soon i write braket";
    expect(isLinkTarget(long)).toBe(false);
    expect(isLinkTarget("1, 2")).toBe(false);
    expect(isLinkTarget('say "hi"')).toBe(false);
    expect(extractLinks(`a [[Finance]] b [[${long}]] c`).wikilinks).toEqual(["Finance"]);
  });
});

describe("math blocks for the assistant", () => {
  const doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "the radius r = 3" }] }, { type: "mathBlock", attrs: { latex: "A = pi*r^2" } }, { type: "mathBlock", attrs: { latex: "w = 2\nh = 5\nS = w*h", tweaks: '{"h":6}' } }] };
  it("finds and works them out", () => {
    const f = mathBlocksIn(doc, "2026-11-17");
    expect(f).toHaveLength(2);
    expect(f[0]).toMatchObject({ target: "A = pi*r^2", path: [1] });
    expect(f[0].answer).toMatch(/28\.27/);
    expect(f[1].answer).toBe("S = 12");
    expect(workOut([], "A = pi*r^2", {}, { r: 1 }).answer).toMatch(/3\.14/);
  });
  it("changes values where they are written", () => {
    expect(setValuesIn("w = 2\nh = 5\nS = w*h", '{"h":6}', { w: 4, h: 1 })).toEqual({ latex: "w = 4\nh = 1\nS = w*h", tweaks: "" });
    expect(setValuesIn("A = pi*r^2", "", { r: 5 })).toEqual({ latex: "A = pi*r^2", tweaks: '{"r":5}' });
  });
});

describe("work and break blocks", () => {
  it("fits blocks around duties", () => {
    const p = planBlocks({ start: at(17), end: at(21), busy: [{ start: at(19), end: at(19, 45), what: "🍽 Dinner" }], total: 150 });
    const work = p.blocks.filter((b) => b.kind === "work");
    expect(p.workMinutes).toBe(150);
    expect(work.every((b) => b.end <= at(19) || b.start >= at(19, 45))).toBe(true);
    expect(p.blocks.some((b) => b.kind === "break")).toBe(true);
    const lines = planLines("Essay", p.blocks);
    expect(lines[0]).toBe("⏰ 17:00 🔨 Essay · work 1 (50 min, till 17:50)");
    expect(lines.some((l) => l.includes("Dinner"))).toBe(true);
  });
  it("says when it doesn't fit", () => {
    const p = planBlocks({ start: at(21), end: at(22), busy: [], total: 120 });
    expect(p.short).toBe(true);
    expect(p.workMinutes).toBeLessThan(120);
  });
});
