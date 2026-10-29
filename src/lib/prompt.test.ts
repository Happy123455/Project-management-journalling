import { describe, expect, it } from "vitest";
import { fillPrompt, promptFields } from "./prompt";

describe("prompt templates", () => {
  it("lists each field once, in order", () => {
    expect(promptFields("Write a {{tone}} email to {{ name }} about {{topic}}. Sign it {{name}}.")).toEqual(["tone", "name", "topic"]);
  });

  it("fills the fields it has and leaves the rest visible", () => {
    expect(fillPrompt("Hi {{name}}, re {{topic}}", { name: "Asha", topic: " " })).toBe("Hi Asha, re {{topic}}");
  });
});
