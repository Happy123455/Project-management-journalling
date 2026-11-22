// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { geminiCall, restingModels, answerText, lightFirst, roundRest } from "./gemini";

const ok = (text: string) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }] }), { status: 200 });
type Fake = (model: string, init: RequestInit) => Promise<Response>;
const fakeFetch = (f: Fake) => ((url: string, init: RequestInit) => f(decodeURIComponent(String(url).split("/models/")[1].split(":")[0]), init)) as unknown as typeof fetch;
const hang = (init: RequestInit) => new Promise<Response>((_, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));

describe("one Gemini path with fallbacks", () => {
  beforeEach(() => restingModels.clear());
  const call = (f: Fake, extra = {}) => geminiCall({ key: "k", model: "gemini-3.1-pro-preview", body: () => ({}), timeoutMs: 40, fetchImpl: fakeFetch(f), quiet: true, ...extra });

  it("Pro hangs: Flash answers, with a note, and Pro rests for a while", async () => {
    const tried: string[] = [];
    const r = await call((m, init) => (tried.push(m), m.includes("pro") ? hang(init) : Promise.resolve(ok("from flash"))));
    expect(answerText(r.json)).toBe("from flash");
    expect(r.model).toBe("gemini-3.8-flash");
    expect(r.note).toBe("Pro didn't answer, used Flash");
    // The next request goes straight to Flash.
    tried.length = 0;
    const again = await call((m) => (tried.push(m), Promise.resolve(ok("hi"))));
    expect(tried[0]).toBe("gemini-3.8-flash");
    expect(again.note).toBe("Pro is struggling, used Flash");
  });

  it("an empty or blocked answer moves on too", async () => {
    const r = await call((m) =>
      Promise.resolve(m.includes("pro") ? new Response(JSON.stringify({ candidates: [{ finishReason: "OTHER" }] })) : m === "gemini-3.8-flash" ? new Response(JSON.stringify({ candidates: [{ content: { parts: [] }, finishReason: "STOP" }] })) : ok("lite")),
    );
    expect(r.model).toBe("gemini-flash-latest");
    expect(r.skipped.map((s) => s.why)).toEqual(["blocked (OTHER)", "answered with nothing"]);
  });

  it("a bad key fails at once; stopping stops", async () => {
    await expect(call(() => Promise.resolve(new Response(JSON.stringify({ error: { message: "API key not valid" } }), { status: 400 })))).rejects.toThrow("isn't valid");
    const ctl = new AbortController();
    const p = call((_m, init) => hang(init), { signal: ctl.signal, timeoutMs: 10_000 });
    ctl.abort();
    await expect(p).rejects.toThrow("Stopped");
  });
});

describe("Gemini keeps trying until it answers", () => {
  beforeEach(() => restingModels.clear());
  it("every model busy, then the lightest answers on a later round", async () => {
    let n = 0;
    const r = await geminiCall({
      key: "k",
      model: "gemini-3.1-pro-preview",
      body: () => ({}),
      timeoutMs: 40,
      quiet: true,
      retryForMs: 20_000,
      fetchImpl: fakeFetch((m) => Promise.resolve(++n <= 7 ? new Response("{}", { status: 503 }) : ok(`from ${m}`))),
    });
    expect(n).toBe(8);
    expect(r.model).toContain("lite");
  });
  it("lightFirst and roundRest", () => {
    expect(lightFirst(["gemini-3.1-pro-preview", "gemini-3.8-flash", "gemini-3.5-flash-lite"])[0]).toBe("gemini-3.5-flash-lite");
    expect([1, 2, 3, 9].map(roundRest)).toEqual([2000, 4000, 8000, 20000]);
  });
});
