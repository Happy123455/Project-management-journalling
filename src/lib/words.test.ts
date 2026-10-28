import { describe, expect, it } from "vitest";
import { countWords, docText, heat } from "./words";

describe("words", () => {
  it("counts words across whitespace and new lines", () => {
    expect(countWords("")).toBe(0);
    expect(countWords("  two words\nthree  ")).toBe(3);
  });

  it("reads the text out of a TipTap document", () => {
    const doc = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "hello there" }] },
        { type: "paragraph", content: [{ type: "text", text: "again" }] },
      ],
    };
    expect(countWords(docText(doc))).toBe(3);
  });

  it("shades days relative to the busiest day", () => {
    expect(heat(0, 100)).toBe(0);
    expect(heat(2, 100)).toBeCloseTo(0.167);
    expect(heat(100, 100)).toBe(1);
  });
});
