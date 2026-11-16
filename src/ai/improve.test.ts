import { describe, expect, it } from "vitest";
import { improvePrompt, maskFields, unmaskFields, wordDiff } from "./improve";
import type { AiAnswer, AiRequest } from "./client";

const fake = (json: unknown) => (async (req: AiRequest) => ({ text: JSON.stringify(json), json, actor: "Gemini", provider: "gemini", model: "x", req }) as unknown as AiAnswer<never>) as never;

describe("✨ Improve (item 6)", () => {
  it("keeps {{fields}} out of the model's hands", () => {
    const { masked, fields } = maskFields("write {{tone}} mail to {{person}}");
    expect(masked).toBe("write ⟦F1⟧ mail to ⟦F2⟧");
    expect(unmaskFields("Write a ⟦F1⟧ email to ⟦F2⟧.", fields)).toBe("Write a {{tone}} email to {{person}}.");
    expect(unmaskFields("Write a email to ⟦F2⟧.", fields)).toBeNull();
    expect(unmaskFields("Write ⟦F1⟧ ⟦F1⟧ to ⟦F2⟧.", fields)).toBeNull();
    expect(unmaskFields("Write ⟦F1⟧ to {{name}} ⟦F2⟧.", fields)).toBeNull();
  });

  it("uses the answer, and refuses one that lost a field", async () => {
    const ok = await improvePrompt("i want u make {{thing}} good", { ask: fake({ improved: "I want you to make ⟦F1⟧ good.", note: "Fixed 'u', added 'to'.", added: ["to"] }) });
    expect(ok).toMatchObject({ text: "I want you to make {{thing}} good.", added: ["to"], actor: "Gemini" });
    await expect(improvePrompt("make {{thing}}", { ask: fake({ improved: "Make it.", note: "", added: [] }) })).rejects.toThrow(/field/);
    await expect(improvePrompt("x", { ask: fake({ improved: " ", note: "", added: [] }) })).rejects.toThrow(/didn't send/);
  });

  it("marks the words that are new", () => {
    const parts = wordDiff("i dont wnat see anything", "I don't want to see anything.");
    expect(parts.filter((p) => p.kind === "new").map((p) => p.text.trim())).toEqual(["want to"]);
    expect(parts.map((p) => p.text).join("")).toBe("I don't want to see anything.");
  });
});
