// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { MemoryStore } from "../store/memoryStore";
import { docText } from "../lib/words";
import type { AiAnswer, AiRequest } from "../ai/client";
import type { LiveState } from "../ai/voice";
import { CHECK_SCHEMA, CHUNK_SCHEMA, FIREWALL_PAGE, SUM_SCHEMA, convictionShift, fallacyName, knownSpeaker, normalizeCheck, normalizeClaims, pageText, priorPremises, tally, todayLines, type CheckRec } from "../lib/firewall";
import { checkSource, checkToToday, defaultDeps, firewallState, loadChecks, resetFirewall, setAfter, sourceOf, startListening, stopListening, type Deps } from "./firewall";

const CHECK = {
  speaker: "Jensen Huang",
  topic: "Selling AI chips to China",
  claims: [
    { n: 1, t: "0:00", quote: "You think giving them any compute means we lose everything", claim: "The critic's view is absurd", premise: "If any compute goes to China, the US loses everything (attributed to critic)", basis: "emotion", fallacies: ["strawman"], contradicts: [], incentive: "Keeps a big market open", plain: "He answers a view nobody stated.", heat: 80 },
    { n: 2, t: "0:26", quote: "It's like DRAM and electricity", claim: "AI chips are commodities", premise: "AI chips are like DRAM, therefore controls are pointless", basis: "assertion", fallacies: ["False analogy"], contradicts: [], incentive: "", plain: "Specialised chips are not a commodity.", heat: 40 },
    { n: 3, t: "1:30", quote: "China will build it anyway", claim: "Controls change nothing", premise: "If China builds the same AI without Nvidia, sales don't matter", basis: "assertion", fallacies: ["doublethink"], contradicts: [7, 2], incentive: "", plain: "Contradicts the claim that Nvidia is irreplaceable.", heat: 50 },
  ],
  contradictions: [{ a: 2, b: 3, why: "Commodity yet decisive" }, { a: 9, b: 1, why: "bad" }],
  past: [{ n: 3, prior: "Our chips are irreplaceable", day: "2026-11-01", why: "Can't be both" }],
  heat: 64,
  verdict: "Confident delivery covering two claims that can't both be true.",
  steelman: "Export controls may speed up Chinese chip makers.",
  holds: ["Controls do push China to build its own chips."],
  ask: ["Why does China buy Nvidia chips if its own are enough?"],
};

function fakeDeps(over: Partial<Deps> = {}) {
  const asked: AiRequest[] = [];
  const answer = (json: unknown): AiAnswer => ({ text: JSON.stringify(json), json, actor: "Gemini", model: "gemini-3.1-pro-preview", provider: "gemini" });
  const deps: Deps = {
    ...defaultDeps,
    provider: async () => "gemini",
    now: () => new Date(2026, 10, 15, 16, 0, 0),
    meta: async () => ({ title: "Jensen Huang gets heated over chips", site: "YouTube · Some Podcast" }),
    fetchHtml: async () => `<html><head><title>Op-ed</title><script>var x=1</script></head><body><nav>Menu</nav><article><p>${"The policy is obviously right and anyone against it hates progress. ".repeat(8)}</p></article></body></html>`,
    ask: async (req) => {
      asked.push(req);
      if (req.schema === CHECK_SCHEMA) return answer(CHECK);
      if (req.schema === CHUNK_SCHEMA) {
        const from = Number(/from (\d+)/.exec(req.text)?.[1] ?? 1);
        return answer({ speaker: "Sam", claims: [{ n: from, t: "", quote: "trust me", claim: "Buy now", premise: "If you wait, you lose", basis: "emotion", fallacies: ["Appeal to emotion"], contradicts: from > 1 ? [1] : [], incentive: "Commission", plain: "Pressure to buy.", heat: 90 }] });
      }
      if (req.schema === SUM_SCHEMA) return answer({ topic: "A sales pitch", heat: 85, verdict: "Urgency, no numbers.", steelman: "Prices may rise.", holds: [], ask: ["What's the price in writing?"], contradictions: [] });
      throw new Error("unexpected");
    },
    appendLines: async (store, day, lines, actor) => {
      const page = await store.getDay(day);
      const p = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
      const content = { type: "doc", content: [...((page?.content as { content?: unknown[] })?.content ?? []), ...lines.map(p)] } as never;
      await store.saveDay({ day, content, plainText: docText(content), actor });
    },
    ...over,
  };
  return { deps, asked };
}

beforeEach(() => resetFirewall());

describe("firewall pure parts", () => {
  it("maps fallacy names to the guide", () => {
    expect(fallacyName("strawman")).toBe("Straw man");
    expect(fallacyName("Ad-hominem attack")).toBe("Ad hominem");
    expect(fallacyName("doublethink")).toBe("Conflicting conditions");
    expect(fallacyName("False analogy")).toBe("False equivalence");
    expect(fallacyName("Something new")).toBe("Something new");
  });

  it("tidies claims: numbers in order, contradictions only backwards to real claims", () => {
    const c = normalizeCheck(CHECK);
    expect(c.claims.map((x) => x.n)).toEqual([1, 2, 3]);
    expect(c.claims[2].contradicts).toEqual([2]);
    expect(c.claims[0].fallacies).toEqual(["Straw man"]);
    expect(c.contradictions).toEqual([{ a: 2, b: 3, why: "Commodity yet decisive" }]);
    expect(c.past).toHaveLength(1);
    const t = tally({ ...c });
    expect(t).toMatchObject({ claims: 3, tricks: 3, contradictions: 2, bare: 3 });
    // A piece numbered on from earlier claims.
    expect(normalizeClaims([{ n: 1, claim: "x", contradicts: [2] }], 4, [1, 2, 3])[0]).toMatchObject({ n: 4, contradicts: [2] });
  });

  it("remembers speakers and their premises", () => {
    const rec = { ...normalizeCheck(CHECK), kind: "check", id: "a", at: "2026-11-01T10:00:00Z", by: "Gemini", model: "", source: { kind: "text" } } as CheckRec;
    expect(knownSpeaker([rec], "Huang gets heated in new interview")).toBe("Jensen Huang");
    expect(knownSpeaker([rec], "A cooking video")).toBe("");
    expect(priorPremises([rec], "jensen huang")).toHaveLength(3);
    expect(convictionShift([{ ...rec, before: 8, after: 4 }, { ...rec, before: 5, after: 5 }])).toEqual({ n: 2, avg: -2 });
    const lines = todayLines({ ...rec, before: 8, after: 4 });
    expect(lines[0]).toContain("[[Jensen Huang]]");
    expect(lines[1]).toContain("36% logic / 64% emotion");
    expect(lines[1]).toContain("8 → 4/10");
  });

  it("reads a page's article text", () => {
    const p = pageText("<html><head><title>T</title><style>.a{}</style></head><body><nav>Home</nav><main><h1>Big claim</h1><p>Reason one.</p></main><footer>©</footer></body></html>");
    expect(p).toEqual({ title: "T", text: "Big claim\nReason one." });
  });

  it("tells a video from a page from text", () => {
    expect(sourceOf("https://youtube.com/shorts/rvs8Nljqmvw?si=x").kind).toBe("youtube");
    expect(sourceOf("https://example.com/op-ed").kind).toBe("link");
    expect(sourceOf("He said that https://x.com proves it").kind).toBe("text");
  });
});

describe("firewall runner", () => {
  it("has Gemini watch a YouTube video and keeps the check", async () => {
    const store = new MemoryStore();
    const { deps, asked } = fakeDeps();
    const r = await checkSource(store, { input: "https://youtube.com/shorts/rvs8Nljqmvw?si=x", before: 8 }, deps);
    expect(r?.claims).toHaveLength(3);
    expect(asked[0].files).toEqual([{ uri: "https://www.youtube.com/watch?v=rvs8Nljqmvw" }]);
    expect(asked[0].text).toContain("Jensen Huang gets heated");
    expect(firewallState().phase).toBe("done");
    await setAfter(store, r!.id, 4);
    const saved = await loadChecks(store);
    expect(saved[0]).toMatchObject({ before: 8, after: 4, speaker: "Jensen Huang" });
    expect(JSON.stringify((await store.getPage(FIREWALL_PAGE))?.content)).toContain("ce-check-");
    // Nothing goes in the notes until ＋ Today.
    expect(await store.getDay("2026-11-15")).toBeNull();
    await checkToToday(store, saved[0], deps);
    expect(docText((await store.getDay("2026-11-15"))!.content)).toContain("🧯 Verdict: Confident delivery");
  });

  it("checks a web page's text, with the speaker's earlier claims", async () => {
    const store = new MemoryStore();
    const { deps, asked } = fakeDeps();
    await checkSource(store, { input: "https://youtu.be/abc123" }, deps);
    resetFirewall();
    await checkSource(store, { input: "https://example.com/op-ed", speaker: "Jensen Huang" }, deps);
    expect(asked[1].files).toBeUndefined();
    expect(asked[1].text).toContain("hates progress");
    expect(asked[1].text).not.toContain("var x");
    expect(asked[1].text).toContain("claimed in earlier checks");
  });

  it("refuses too little text, and shows the error", async () => {
    const store = new MemoryStore();
    const { deps, asked } = fakeDeps();
    expect(await checkSource(store, { input: "it's obvious" }, deps)).toBeNull();
    expect(firewallState()).toMatchObject({ phase: "error" });
    expect(asked).toHaveLength(0);
  });

  it("listens live: pieces are audited as they come, then summed up and saved", async () => {
    const store = new MemoryStore();
    let push: (s: LiveState) => void = () => {};
    let words = "";
    const { deps, asked } = fakeDeps({
      listen: async (onState) => {
        push = onState;
        return { stop: async () => ({ text: words, audio: null, seconds: 60, startedAt: new Date() }), cancel: () => {} };
      },
    });
    await startListening(store, { before: 7 }, deps);
    expect(firewallState().phase).toBe("listening");
    words = "You have to buy this today. ".repeat(30);
    push({ seconds: 30, level: 0.2, text: words, waiting: 0, engine: "gemini" });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(firewallState().live?.claims).toHaveLength(1);
    words += "Everyone is buying. ".repeat(10);
    const r = await stopListening(store);
    expect(r?.claims.map((c) => c.n)).toEqual([1, 2]);
    expect(r?.claims[1].contradicts).toEqual([1]);
    expect(r).toMatchObject({ speaker: "Sam", verdict: "Urgency, no numbers.", before: 7, source: { kind: "live" } });
    expect(asked.filter((a) => a.schema === CHUNK_SCHEMA)).toHaveLength(2);
    expect((await loadChecks(store))[0].transcript).toContain("Everyone is buying");
  });
});
