// @vitest-environment happy-dom
import { beforeAll, describe, expect, it } from "vitest";
import { MemoryStore } from "../store/memoryStore";
import { setKey } from "./secrets";
import { answerSchema, decide, decideMany, loadConfigs, NODE_PLACEMENT, placeNodes, saveConfigs, score, type DecisionConfig } from "./decide";

const cfg: DecisionConfig = {
  id: "t",
  name: "Test",
  input: { content: "text", delivery: "inline", mediaResolution: "low", model: "gemini-flash-lite-latest" },
  questions: [
    { key: "useful", type: "bool", instruction: "Is it useful?", expect: true },
    { key: "kind", type: "choice", instruction: "What kind?", options: ["work", "fun", "other"], accept: ["work"] },
    { key: "depth", type: "score", instruction: "How deep?", min: 1, max: 5, pass: 3 },
  ],
  scoring: { mode: "all", minConfidence: 0.6 },
};

/** A fake Gemini that answers with `answer(body)` as JSON text, and records the requests. */
function fakeGemini(answer: (body: { contents: { parts: { text?: string }[] }[]; generationConfig: Record<string, unknown> }) => unknown, statuses: number[] = []) {
  const seen: { url: string; body: ReturnType<typeof JSON.parse> }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    seen.push({ url, body });
    const status = statuses.shift() ?? 200;
    if (status !== 200) return new Response("busy", { status });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(answer(body)) }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }), { status: 200 });
  }) as unknown as typeof fetch;
  return { f, seen };
}

beforeAll(async () => {
  await setKey("gemini", "test-key");
});

describe("decision models", () => {
  it("builds a schema with one answer per question", () => {
    const s = answerSchema(cfg.questions) as { properties: Record<string, { properties: { value: Record<string, unknown> } }>; required: string[] };
    expect(s.required).toEqual(["useful", "kind", "depth"]);
    expect(s.properties.useful.properties.value).toEqual({ type: "boolean" });
    expect(s.properties.kind.properties.value).toEqual({ type: "string", enum: ["work", "fun", "other"] });
    expect(s.properties.depth.properties.value).toEqual({ type: "integer", minimum: 1, maximum: 5 });
  });

  it("scores against the thresholds: all, any, and unsure below the confidence", () => {
    const sure = (value: boolean | string | number) => ({ value, confidence: 0.9 });
    expect(score(cfg, { useful: sure(true), kind: sure("work"), depth: sure(4) }).verdict).toBe("yes");
    const v = score(cfg, { useful: sure(true), kind: sure("fun"), depth: sure(4) });
    expect(v.verdict).toBe("no");
    expect(v.passed).toEqual({ useful: true, kind: false, depth: true });
    expect(score({ ...cfg, scoring: { mode: "any", minConfidence: 0.6 } }, { useful: sure(false), kind: sure("fun"), depth: sure(3) }).verdict).toBe("yes");
    expect(score(cfg, { useful: sure(true), kind: sure("work"), depth: { value: 5, confidence: 0.3 } }).verdict).toBe("unsure");
    expect(score(cfg, { useful: sure(true), kind: sure("work") }).verdict).toBe("unsure");
  });

  it("decide sends the media resolution and schema, and falls back when a model is busy", async () => {
    const { f, seen } = fakeGemini(() => ({ useful: { value: true, confidence: 0.8 }, kind: { value: "work", confidence: 0.9 }, depth: { value: 3, confidence: 0.7, why: "ok" } }), [503]);
    const v = await decide(cfg, { text: "Notes on the sprint plan", media: [{ mime: "image/png", data: "AAAA" }] }, f);
    expect(v.verdict).toBe("yes");
    expect(v.answers.depth.why).toBe("ok");
    expect(seen).toHaveLength(2);
    expect(seen[0].url).toContain("gemini-flash-lite-latest");
    expect(seen[1].url).not.toContain("gemini-flash-lite-latest");
    expect(seen[1].body.generationConfig.mediaResolution).toBe("MEDIA_RESOLUTION_LOW");
    expect(seen[1].body.generationConfig.responseMimeType).toBe("application/json");
    expect(seen[1].body.contents[0].parts[0].inlineData.mimeType).toBe("image/png");
  });

  it("decideMany judges many items in one request, in order, even when answered out of order", async () => {
    const { f, seen } = fakeGemini(() => ({
      items: [
        { i: 1, useful: { value: false, confidence: 0.9 }, kind: { value: "fun", confidence: 0.9 }, depth: { value: 1, confidence: 0.9 } },
        { i: 0, useful: { value: true, confidence: 0.9 }, kind: { value: "work", confidence: 0.9 }, depth: { value: 5, confidence: 0.9 } },
      ],
    }));
    const vs = await decideMany(cfg, ["plan", "meme", "missing"], f);
    expect(seen).toHaveLength(1);
    expect(vs.map((v) => v.verdict)).toEqual(["yes", "no", "unsure"]);
  });

  it("placeNodes puts sure lines under their branch and the rest on new branches", async () => {
    const { f, seen } = fakeGemini(() => ({
      items: [
        { i: 0, branch: { value: "Budget", confidence: 0.9 }, fit: { value: 5, confidence: 0.9 } },
        { i: 1, branch: { value: "new", confidence: 0.9 }, fit: { value: 4, confidence: 0.9 } },
        { i: 2, branch: { value: "Design", confidence: 0.4 }, fit: { value: 4, confidence: 0.9 } },
        { i: 3, branch: { value: "Design", confidence: 0.9 }, fit: { value: 2, confidence: 0.9 } },
      ],
    }));
    const out = await placeNodes(["rent is 900", "call the vet", "maybe blue", "fonts?"], [{ id: "b1", label: "Budget" }, { id: "b2", label: "Design" }], NODE_PLACEMENT, f);
    expect(out).toEqual(["b1", null, null, null]);
    const enumOf = seen[0].body.generationConfig.responseSchema.properties.items.items.properties.branch.properties.value.enum;
    expect(enumOf).toEqual(["Budget", "Design", "new"]);
    // No branches yet: no request at all.
    expect(await placeNodes(["a"], [], NODE_PLACEMENT, f)).toEqual([null]);
    expect(seen).toHaveLength(1);
  });

  it("configs save to the page and load back, always with node placement", async () => {
    const store = new MemoryStore();
    expect((await loadConfigs(store)).map((c) => c.id)).toEqual(["node-placement"]);
    await saveConfigs(store, [cfg]);
    expect((await loadConfigs(store)).map((c) => c.id)).toEqual(["node-placement", "t"]);
    const tuned = { ...NODE_PLACEMENT, scoring: { mode: "all" as const, minConfidence: 0.8 } };
    await saveConfigs(store, [tuned, cfg]);
    const back = await loadConfigs(store);
    expect(back[0].scoring.minConfidence).toBe(0.8);
    expect(back).toHaveLength(2);
  });
});
