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
