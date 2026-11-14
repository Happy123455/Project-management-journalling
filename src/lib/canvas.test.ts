import { describe, expect, it } from "vitest";
import { entryStart, itemsFromBlocks, keywordGroups, layoutCanvas, momentsOf, NODE_W, noonOf, OTHER, branchOf, UNSORTED } from "./canvas";

const p = (text: string, attrs: Record<string, unknown> = {}) => ({ type: "paragraph", attrs: { indent: 0, ...attrs }, content: text ? [{ type: "text", text }] : undefined });
const task = (text: string, checked = false, born?: string) => ({
  type: "taskItem",
  attrs: { checked, lid: `t-${text.slice(0, 6)}` },
  content: [{ type: "paragraph", attrs: { born: born ?? null }, content: [{ type: "text", text }] }],
});

describe("canvas items", () => {
  it("turns a [[Journal]] label line with an indented task list into one item per task, timed by when typing began", () => {
    const blocks = [
      p("[[Journal]]", { born: "2026-11-12T10:00:00.000Z", lid: "lab" }),
      { type: "taskList", attrs: { indent: 1 }, content: [task("Sync clash fix", false, "2026-11-12T10:01:00.000Z"), task("Meme sound volume", true)] },
    ];
    const items = itemsFromBlocks(blocks, { day: "2026-11-12", self: "Journal", fallbackMs: entryStart(blocks, "2026-11-12") });
    expect(items.map((i) => i.label)).toEqual(["Sync clash fix", "Meme sound volume"]);
    expect(items[0].ms).toBe(Date.parse("2026-11-12T10:01:00.000Z"));
    expect(items[0].when).toBe("born");
    // No time of its own: right after the line above it.
    expect(items[1].when).toBe("near");
    expect(items[1].kind).toBe("done");
    expect(items[0].section).toBe("");
    expect(items[0].lid).toBe("t-Sync c");
  });

  it("reads Hapi's timestamps, skips ✎ edit stamps, and keeps deeper lines with their paragraph", () => {
    const blocks = [
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Ideas" }] },
      p("✎ 13,November,2026 Friday (09:00:00) 12,November,2026 Thursday (22:04:26) eye tracker game"),
      p("calibrate by 4 corners", { indent: 1 }),
      p("another idea"),
    ];
    const items = itemsFromBlocks(blocks, { day: "2026-11-12", fallbackMs: noonOf("2026-11-12") });
    expect(items).toHaveLength(2);
    expect(items[0].when).toBe("stamp");
    expect(new Date(items[0].ms).getHours()).toBe(22);
    expect(items[0].text).toContain("calibrate by 4 corners");
    expect(items[0].label).toBe("eye tracker game");
    expect(items[0].section).toBe("Ideas");
    expect(items[1].ms).toBe(items[0].ms);
  });

  it("guesses the fallback time when nothing is written", () => {
    const items = itemsFromBlocks([p("hello there")], { day: "2026-11-01", fallbackMs: noonOf("2026-11-01") });
    expect(items[0].when).toBe("guess");
    expect(items[0].ms).toBe(noonOf("2026-11-01"));
  });
});

describe("canvas branches", () => {
  it("groups lines by the words they share, the rest under Other", () => {
    const items = [
      { key: "a", text: "sync clash on phone" },
      { key: "b", text: "sync log is slow" },
      { key: "c", text: "deadline bar colours" },
      { key: "d", text: "deadline bar steps" },
      { key: "e", text: "eye tracker" },
    ];
    const g = keywordGroups(items, "Journal");
    expect(g.get("a")).toBe(g.get("b"));
    expect(g.get("a")).toBe("Sync");
    expect(g.get("c")).toBe(g.get("d"));
    expect(g.get("e")).toBe(OTHER);
  });

  it("puts lines the AI hasn't sorted yet on their own branch", () => {
    const items = itemsFromBlocks([p("one", { lid: "x1" }), p("two", { lid: "x2" })], { day: "2026-11-01", fallbackMs: noonOf("2026-11-01") });
    const map = branchOf(items, "topics", "J", { x1: "First" });
    expect(map.get("x1")).toBe("First");
    expect(map.get("x2")).toBe(UNSORTED);
  });
});

describe("canvas layout", () => {
  const mk = (key: string, day: string, h: number) => ({
    key, text: key, label: key, ms: new Date(`${day}T${String(h).padStart(2, "0")}:00:00`).getTime(), when: "stamp" as const, day, section: "", tags: [], kind: "line" as const, order: 0,
  });
  it("one column per day, a row per branch, empty stretches folded", () => {
    const items = [mk("a", "2026-11-01", 9), mk("b", "2026-11-02", 9), mk("c", "2026-11-20", 9)];
    const L = layoutCanvas(items, new Map([["a", "X"], ["b", "Y"], ["c", "X"]]));
    expect(L.unit).toBe("day");
    expect(L.branches.map((b) => b.name)).toEqual(["X", "Y"]);
    expect(L.columns.some((c) => c.gap)).toBe(true);
    const a = L.items.find((i) => i.key === "a")!;
    const c = L.items.find((i) => i.key === "c")!;
    expect(a.y).toBe(c.y);
    expect(c.x).toBeGreaterThan(a.x + NODE_W);
    expect(L.width).toBeGreaterThan(c.x + NODE_W);
  });
  it("a single day is laid out by hour", () => {
    const L = layoutCanvas([mk("a", "2026-11-01", 9), mk("b", "2026-11-01", 14)], new Map());
    expect(L.unit).toBe("hour");
    expect(L.columns).toHaveLength(6);
    expect(momentsOf(L.items)).toHaveLength(2);
  });
});
