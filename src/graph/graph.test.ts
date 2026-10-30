import { describe, expect, it } from "vitest";
import { buildGraph, dayColor, forceStep, treeLayout, type Point } from "./graph";

const links = [
  { day: "2026-10-20", title: null, target: "Ravi", kind: "wikilink" as const },
  { day: "2026-10-25", title: null, target: "ravi", kind: "wikilink" as const },
  { day: "2026-10-25", title: null, target: "work", kind: "tag" as const },
  { day: null, title: "Ravi", target: "Project X", kind: "wikilink" as const },
];

describe("graph", () => {
  it("builds days, pages and tags with one edge per link", () => {
    const g = buildGraph(links);
    expect(g.nodes.map((n) => n.id).sort()).toEqual(["day:2026-10-20", "day:2026-10-25", "page:project x", "page:ravi", "tag:work"]);
    expect(g.edges).toHaveLength(4);
    const ravi = g.nodes.find((n) => n.id === "page:ravi")!;
    expect(ravi).toMatchObject({ day: "2026-10-20", degree: 3 });
  });

  it("colours days by month and date", () => {
    expect(dayColor("2026-01-01")).toBe("hsl(220, 75%, 78%)");
    expect(dayColor("2026-01-31")).toBe("hsl(220, 75%, 36%)");
    expect(dayColor("2026-02-16")).toBe("hsl(250, 75%, 57%)");
    expect(dayColor("2026-06-01")).toBe("hsl(10, 75%, 78%)");
  });

  it("grows the tree upwards in date order, branching out at first mention", () => {
    const pos = treeLayout(buildGraph(links));
    expect(pos.get("day:2026-10-25")!.y).toBeLessThan(pos.get("day:2026-10-20")!.y);
    expect(Math.abs(pos.get("day:2026-10-20")!.x)).toBeLessThanOrEqual(16);
    expect(Math.abs(pos.get("page:ravi")!.x)).toBeGreaterThan(100);
  });

  it("settles a force layout", () => {
    const g = buildGraph(links);
    const pos = new Map<string, Point>(g.nodes.map((n, i) => [n.id, { x: Math.cos(i) * 50, y: Math.sin(i) * 50 }]));
    const vel = new Map<string, Point>();
    let moved = Infinity;
    for (let i = 0; i < 400; i++) moved = forceStep(g, pos, vel);
    expect(moved).toBeLessThan(0.5);
    for (const p of pos.values()) expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
  });
});
