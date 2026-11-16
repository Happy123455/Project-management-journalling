import { describe, expect, it } from "vitest";
import { actorFor, estimateCost } from "./providers";

describe("AI providers", () => {
  it("names AI edits after the provider", () => {
    expect(actorFor("gemini")).toBe("Gemini");
    expect(actorFor("claude")).toBe("Claude");
  });

  it("estimates cost from published prices, including dated price changes", () => {
    expect(estimateCost("gemini-3.8-flash", 1_000_000, 0, "2026-10-28")).toBeCloseTo(0.75);
    expect(estimateCost("gemini-3.8-flash", 1_000_000, 0, "2027-01-02")).toBeCloseTo(1.5);
    expect(estimateCost("claude-haiku-5-5", 2_000, 1_000, "2026-10-28")).toBeCloseTo(0.0007);
    expect(estimateCost("some-new-model", 10, 10, "2026-10-28")).toBeNull();
  });
});

describe("local model", () => {
  it("records its edits under the model's name", () => {
    expect(actorFor("local", "qwen3:14b")).toBe("Local (qwen3)");
  });
});

import { fallbackChain, restingModels, tierOf, unusable } from "./gemini";

describe("Gemini fallbacks", () => {
  it("goes down from the model asked for: Pro → Flash → Flash-Lite", () => {
    const chain = fallbackChain("gemini-3.1-pro-preview", undefined, 0, new Map());
    expect(chain.map(tierOf)).toEqual(["pro", "flash", "flash", "flash", "lite", "lite"]);
    expect(chain[0]).toBe("gemini-3.1-pro-preview");
    expect(fallbackChain("gemini-3.8-flash", undefined, 0, new Map()).map(tierOf)).toEqual(["flash", "flash", "flash", "lite", "lite"]);
    // Lite has nothing lower: Flash is the spare, never Pro.
    expect(fallbackChain("gemini-3.5-flash-lite", undefined, 0, new Map()).map(tierOf)).toEqual(["lite", "lite", "flash", "flash", "flash"]);
  });
  it("follows the order set in Settings", () => {
    expect(fallbackChain("gemini-3.1-pro-preview", ["pro", "lite", "flash"], 0, new Map()).map(tierOf)).toEqual(["pro", "lite", "lite", "flash", "flash", "flash"]);
  });
  it("puts a model that just failed last for 10 minutes, but never leaves nothing", () => {
    const rest = new Map([["gemini-3.1-pro-preview", 1000]]);
    expect(fallbackChain("gemini-3.1-pro-preview", undefined, 2000, rest)[0]).toBe("gemini-3.8-flash");
    expect(fallbackChain("gemini-3.1-pro-preview", undefined, 2000, rest).pop()).toBe("gemini-3.1-pro-preview");
    expect(fallbackChain("gemini-3.1-pro-preview", undefined, 1000 + 11 * 60_000, rest)[0]).toBe("gemini-3.1-pro-preview");
    expect(restingModels.size).toBe(0);
  });
  it("calls an empty, blocked or cut-off answer unusable", () => {
    expect(unusable({ candidates: [{ content: { parts: [{ text: "hi" }] }, finishReason: "STOP" }] })).toBeNull();
    expect(unusable({ candidates: [{ content: { parts: [] }, finishReason: "STOP" }] })).toBe("answered with nothing");
    expect(unusable({ candidates: [{ content: { parts: [] }, finishReason: "STOP" }] }, true)).toBeNull();
    expect(unusable({ candidates: [{ finishReason: "SAFETY" }] })).toBe("blocked (SAFETY)");
    expect(unusable({ promptFeedback: { blockReason: "OTHER" } })).toBe("blocked (OTHER)");
    expect(unusable({ candidates: [{ content: { parts: [{ text: "thinking", thought: true }] }, finishReason: "MAX_TOKENS" }] })).toBe("ran out of room before answering");
    expect(unusable({ candidates: [{ content: { parts: [{ functionCall: { name: "x" } }] } }] })).toBeNull();
  });
});
