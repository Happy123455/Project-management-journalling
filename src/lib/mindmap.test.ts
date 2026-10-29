import { describe, expect, it } from "vitest";
import { MemoryStore } from "../store/memoryStore";
import { applyGrowth, emptyMap, loadMap, MAX_NEW_PER_DAY, parseGrowth, ROOT_ID, saveMap } from "./mindmap";

let n = 0;
const id = () => `n${++n}`;

describe("mind map", () => {
  it("drops malformed AI answers", () => {
    const g = parseGrowth({ attach: [{ existingId: "me", newLabel: "Trip", kind: "weird" }, { newLabel: "no parent" }, 5], reinforce: ["x", 3], link: [{ a: "a", b: "a" }] });
    expect(g).toEqual({ attach: [{ existingId: "me", newLabel: "Trip", kind: "idea" }], reinforce: ["x"], link: [] });
    expect(parseGrowth("nonsense")).toEqual({ attach: [], reinforce: [], link: [] });
  });

  it("only grows: branches on existing nodes, reinforcement, links; never rebuilds; once per day", () => {
    let m = applyGrowth(emptyMap(), parseGrowth({ attach: [{ existingId: ROOT_ID, newLabel: "Trip", kind: "project" }] }), "2026-10-28", id);
    const trip = m.nodes.find((x) => x.label === "Trip")!;
    m = applyGrowth(m, parseGrowth({ attach: [{ existingId: trip.id, newLabel: "Goa", kind: "idea" }, { existingId: "ghost", newLabel: "Lost" }], reinforce: [trip.id], link: [{ a: trip.id, b: ROOT_ID }] }), "2026-10-29", id);
    expect(m.nodes.map((x) => x.label)).toEqual(["Me", "Trip", "Goa"]);
    expect(m.nodes[1]).toMatchObject({ weight: 2, firstSeenDay: "2026-10-28", lastSeenDay: "2026-10-29" });
    expect(m.links).toHaveLength(1);
    expect(applyGrowth(m, parseGrowth({ attach: [{ existingId: ROOT_ID, newLabel: "Again" }] }), "2026-10-29", id)).toBe(m);
  });

  it("caps new ideas per day", () => {
    const many = { attach: Array.from({ length: 30 }, (_, i) => ({ existingId: ROOT_ID, newLabel: `Idea ${i}` })) };
    expect(applyGrowth(emptyMap(), parseGrowth(many), "2026-10-29", id).nodes).toHaveLength(1 + MAX_NEW_PER_DAY);
  });

  it("is saved as Gemini's edit, listed in AI changes and undoable", async () => {
    const store = new MemoryStore();
    await saveMap(store, emptyMap(), "me");
    await saveMap(store, applyGrowth(emptyMap(), parseGrowth({ attach: [{ existingId: ROOT_ID, newLabel: "Trip" }] }), "2026-10-29", id), "Gemini");
    expect((await loadMap(store)).nodes).toHaveLength(2);
    const [change] = await store.aiChanges(5);
    expect(change.event.actor).toBe("Gemini");
    expect(await store.undoAiChange(change.event.id)).toBe(true);
    expect((await loadMap(store)).nodes).toHaveLength(1);
  });
});
