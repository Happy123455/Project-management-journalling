import { describe, expect, it } from "vitest";
import { applyGrowth, applyMerges, emptyMap, parseGrowth, placeNew, ROOT_ID } from "./mindmap";
import { projectText } from "./projects";

let n = 0;
const id = () => `n${++n}`;
const p = (text: string, indent = 0) => ({ type: "paragraph", attrs: { indent }, content: [{ type: "text", text }] });

describe("mind map as a tree", () => {
  it("places new nodes without moving the ones already placed, spaced apart", () => {
    let m = placeNew(applyGrowth(emptyMap(), parseGrowth({ attach: [{ existingId: ROOT_ID, newLabel: "Health", id: "h" }, { existingId: "h", newLabel: "Gym" }, { existingId: "h", newLabel: "Sleep" }] }), "2026-11-01", id));
    const before = new Map(m.nodes.map((x) => [x.id, [x.x, x.y]]));
    expect(m.nodes).toHaveLength(4);
    const health = m.nodes.find((x) => x.label === "Health")!;
    expect(m.nodes.find((x) => x.label === "Gym")!.parent).toBe(health.id);
    m = placeNew(applyGrowth(m, parseGrowth({ attach: [{ existingId: health.id, newLabel: "Walks" }, { existingId: ROOT_ID, newLabel: "Work" }] }), "2026-11-02", id));
    for (const x of m.nodes) if (before.has(x.id)) expect([x.x, x.y]).toEqual(before.get(x.id));
    const pts = m.nodes.map((x) => [x.x!, x.y!]);
    for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) expect(Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1])).toBeGreaterThan(60);
  });

  it("grows a day again only on request, never counting a day twice", () => {
    const m = applyGrowth(emptyMap(), parseGrowth({ attach: [{ existingId: ROOT_ID, newLabel: "Trip" }] }), "2026-11-01", id);
    const trip = m.nodes[1];
    const again = applyGrowth(m, parseGrowth({ attach: [{ existingId: ROOT_ID, newLabel: "Food" }], reinforce: [trip.id] }), "2026-11-01", id, true);
    expect(again.nodes.map((x) => x.label)).toEqual(["Me", "Trip", "Food"]);
    expect(again.nodes[1].weight).toBe(1);
    expect(again.processedDays).toEqual(["2026-11-01"]);
  });

  it("folds duplicates together, keeping branches and places", () => {
    let m = placeNew(applyGrowth(emptyMap(), parseGrowth({ attach: [{ existingId: ROOT_ID, newLabel: "Workout", id: "a" }, { existingId: ROOT_ID, newLabel: "Exercise", id: "b" }, { existingId: "a", newLabel: "Legs" }] }), "2026-11-01", id));
    const [, a, b, legs] = m.nodes;
    m = applyMerges(m, [{ from: a.id, into: b.id }, { from: ROOT_ID, into: b.id }]);
    expect(m.nodes.map((x) => x.label)).toEqual(["Me", "Exercise", "Legs"]);
    expect(m.nodes[2]).toMatchObject({ parent: b.id, x: legs.x, y: legs.y });
  });

  it("reads only a project's own box from a note", () => {
    const doc = { type: "doc", content: [p("Breakfast"), p("[[Garden]] plans"), p("buy seeds", 1), p("dig beds", 1), p("Call mum")] };
    expect(projectText(doc, "Garden")).toBe("[[Garden]] plans\n  buy seeds\n  dig beds");
  });
});
