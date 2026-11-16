import { describe, expect, it, vi } from "vitest";
import { EMPTY_GRAPH, graphFor, layoutGraph, makeMyPrompt, parseGraph, worthUpdating } from "./talkGraph";

describe("talk graph", () => {
  it("cleans what the model sends", () => {
    const g = parseGraph({
      nodes: [
        { id: "t", label: "Trip to Goa", kind: "topic", state: "open" },
        { id: "a", label: "Book train", kind: "task", state: "open" },
        { id: "a", label: "dup", kind: "idea" },
        { id: "b", label: "Budget?", kind: "weird", state: "done" },
        { id: "", label: "no id" },
      ],
      edges: [{ from: "t", to: "a" }, { from: "t", to: "zzz" }, { from: "a", to: "a" }],
      unfinished: ["still explaining the budget", ""],
    });
    expect(g.nodes.map((n) => `${n.id}:${n.kind}:${n.state}`)).toEqual(["t:topic:open", "a:task:open", "b:idea:done"]);
    expect(g.edges).toEqual([{ from: "t", to: "a" }]);
    expect(g.unfinished).toEqual(["still explaining the budget"]);
    expect(parseGraph("not json")).toEqual(EMPTY_GRAPH);
  });
  it("asks again only when it's worth it", () => {
    expect(worthUpdating("I want to plan a trip.", "")).toBe(true);
    expect(worthUpdating("I want to plan a trip", "I want to plan a tri")).toBe(false);
    expect(worthUpdating("I want to plan a trip. We go by train.", "I want to plan a trip.")).toBe(true);
    expect(worthUpdating("same", "same")).toBe(false);
  });
  it("sends the previous graph and reads the answer", async () => {
    const ask = vi.fn(async () => ({ text: "", json: { nodes: [{ id: "t", label: "Trip", kind: "topic", state: "open" }], edges: [], unfinished: [] }, provider: "gemini" as const, model: "m", actor: "Gemini" }));
    const g = await graphFor("plan a trip.", EMPTY_GRAPH, ask as never);
    expect(g.nodes[0].label).toBe("Trip");
    expect((ask.mock.calls[0] as unknown as [{ text: string; task: string }])[0].text).toContain("Previous graph:");
  });
  it("lays every node out inside the box", () => {
    const nodes = [{ id: "t", label: "T", kind: "topic" as const, state: "open" as const }, ...Array.from({ length: 14 }, (_, i) => ({ id: `n${i}`, label: `N${i}`, kind: "idea" as const, state: "open" as const }))];
    const pos = layoutGraph({ nodes, edges: [], unfinished: [] }, 340, 260);
    expect(pos.size).toBe(15);
    for (const p of pos.values()) expect(p.x >= 0 && p.x <= 340 && p.y >= 0 && p.y <= 260).toBe(true);
  });
  it("makes the prompt with the stronger model, keeping {{fields}}", async () => {
    const ask = vi.fn(async () => ({ text: "", json: { improved: "Plan a trip to ⟦F1⟧ by train.", note: "Organised.", added: ["to"] }, provider: "gemini" as const, model: "pro", actor: "Gemini" }));
    const r = await makeMyPrompt("plan trip {{place}} train", ask as never);
    expect(r.text).toBe("Plan a trip to {{place}} by train.");
    const req = (ask.mock.calls[0] as unknown as [{ task: string; provider: string }])[0];
    expect([req.task, req.provider]).toEqual(["organise", "gemini"]);
  });
});
