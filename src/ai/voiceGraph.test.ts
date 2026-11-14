// @vitest-environment happy-dom
import { beforeAll, describe, expect, it } from "vitest";
import { MemoryStore } from "../store/memoryStore";
import { loadoutFrom } from "../lib/canvasLoadout";
import { addFeatures, addPrompt, emptyGraph, mindMapFromGraph, splitIdeas } from "../lib/graphFormat";
import { setKey } from "./secrets";
import { buildVoiceGraph, graphNames, loadGraph } from "./voiceGraph";
import { clean } from "./voice";

beforeAll(async () => {
  await setKey("gemini", "test-key");
});

/** A fake Gemini: answers by what the request asks for. */
function fake(answers: { branches?: string[]; place?: (items: string[]) => unknown; group?: (items: string[]) => unknown }) {
  const asked: string[] = [];
  const f = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const text: string = body.contents[0].parts.map((p: { text?: string }) => p.text ?? "").join("");
    const items = text.split("\n").filter((l) => /^\d+\. /.test(l)).map((l) => l.replace(/^\d+\. /, ""));
    let out: unknown;
    if (text.startsWith("Name the")) (asked.push("branches"), (out = { branches: answers.branches ?? [] }));
    else if (text.includes("don't fit")) (asked.push("group"), (out = answers.group!(items)));
    else (asked.push("place"), (out = answers.place!(items.filter((l) => !/^\w+: /.test(l)))));
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(out) }] } }] }), { status: 200 });
  }) as unknown as typeof fetch;
  return { f, asked };
}

const talk = "We need to fix the budget for the trip. Rent is about nine hundred a month. The logo should be blue and simple. Also call the vet tomorrow about the dog.";

describe("the graph format", () => {
  it("splits a talk into ideas, joining tiny sentences", () => {
    expect(splitIdeas("Okay. So the plan is to ship on Friday. Yes! And then we rest for a week.")).toEqual(["Okay. So the plan is to ship on Friday.", "Yes! And then we rest for a week."]);
    const long = splitIdeas(`${"word ".repeat(120)}end.`);
    expect(long.length).toBeGreaterThan(1);
    expect(long.every((t) => t.length <= 280)).toBe(true);
    expect(clean("[BLANK_AUDIO]")).toBe("");
    expect(clean(" hello  there ")).toBe("hello there");
  });

  it("a prompt's parts join back into its text exactly, and Canvas and the mind map read it", () => {
    let g = addFeatures(emptyGraph("Trip"), ["Budget", "Design"]).graph;
    g = addPrompt(g, { at: new Date(2026, 10, 14, 9, 30), thread: "🎙️ Voice", ideas: ["Rent is 900.", "Blue logo."], branchIds: ["f1", "f2"] });
    expect(g.prompts[0].text).toBe("Rent is 900. Blue logo.");
    expect(g.segs.map((s) => s.text).join("")).toBe(g.prompts[0].text);
    const lo = loadoutFrom(g, "Trip");
    expect(lo.items.map((i) => lo.branches.get(i.key))).toEqual(["Budget", "Design"]);
    expect(lo.items[0].day).toBe("2026-11-14");
    const m = mindMapFromGraph(g, "Trip");
    expect(m.nodes.find((n) => n.parent === null)?.label).toBe("Trip");
    expect(m.nodes.filter((n) => n.parent === "f:f1").map((n) => n.label)).toEqual(["Rent is 900."]);
    expect(m.processedDays).toEqual(["2026-11-14"]);
    // Same label again: the branch is reused.
    expect(addFeatures(g, ["budget"]).ids).toEqual(["f1"]);
  });
});

describe("voice graphs", () => {
  it("a new graph: branches from the talk, sure ideas placed, the rest on new branches", async () => {
    const store = new MemoryStore();
    const { f, asked } = fake({
      branches: ["Budget", "Design"],
      place: (items) => ({
        items: items.map((t, i) => ({
          i,
          branch: { value: /budget|rent/i.test(t) ? "Budget" : /logo/i.test(t) ? "Design" : "new", confidence: 0.9 },
          fit: { value: 4, confidence: 0.9 },
        })),
      }),
      group: (items) => ({ items: items.map((_, i) => ({ i, branch: "Pets" })) }),
    });
    const r = await buildVoiceGraph(store, { name: "Trip", transcript: talk, at: new Date(2026, 10, 14, 10, 0), fetchImpl: f });
    expect(asked).toEqual(["branches", "place", "group"]);
    expect(r.newBranches).toEqual(["Budget", "Design", "Pets"]);
    const g = (await loadGraph(store, "Trip"))!;
    const branchOf = (needle: string) => g.features.find((x) => x.id === g.segs.find((s) => s.text.includes(needle))?.f)?.label;
    expect(branchOf("Rent")).toBe("Budget");
    expect(branchOf("logo")).toBe("Design");
    expect(branchOf("vet")).toBe("Pets");
    expect(await graphNames(store)).toEqual(["Trip"]);
    // The save is the AI's (it can be undone).
    expect((await store.aiChanges()).some((c) => c.event.actor === "Gemini" && c.title === "Graph · Trip")).toBe(true);
  });

  it("a second talk adds to the same graph without asking for branches again", async () => {
    const store = new MemoryStore();
    const place = (items: string[]) => ({ items: items.map((_, i) => ({ i, branch: { value: "Budget", confidence: 0.95 }, fit: { value: 5, confidence: 0.9 } })) });
    await buildVoiceGraph(store, { name: "Trip", transcript: "The budget is tight this month, we need to save money.", at: new Date(), fetchImpl: fake({ branches: ["Budget"], place }).f });
    const second = fake({ place });
    const r = await buildVoiceGraph(store, { name: "Trip", transcript: "Flights will cost around four hundred each way.", at: new Date(), fetchImpl: second.f });
    expect(second.asked).toEqual(["place"]);
    expect(r.newBranches).toEqual([]);
    expect(r.graph.prompts).toHaveLength(2);
    expect(r.graph.segs.every((s) => s.f === "f1")).toBe(true);
    await expect(buildVoiceGraph(store, { name: "Trip", transcript: "  ", at: new Date(), fetchImpl: second.f })).rejects.toThrow(/Nothing/);
  });
});
