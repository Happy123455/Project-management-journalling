import { describe, expect, it } from "vitest";
import { findRanges, highlightParts, matchText, searchTerms } from "./search";

describe("search", () => {
  it("splits words and keeps quoted phrases", () => {
    expect(searchTerms(' Ravi  "project x" ')).toEqual(["ravi", "project x"]);
  });

  it("needs every word somewhere on the page", () => {
    const text = "Met Ravi today\nlunch\nProject X with ravi";
    expect(matchText(text, ["ravi", "project"])).toEqual({
      count: 3,
      lines: [
        { text: "Met Ravi today", ranges: [{ start: 4, end: 8 }] },
        { text: "Project X with ravi", ranges: [{ start: 0, end: 7 }, { start: 15, end: 19 }] },
      ],
    });
    expect(matchText(text, ["ravi", "dinner"])).toBeNull();
  });

  it("merges overlapping hits and splits a line for highlighting", () => {
    expect(findRanges("banana", ["an", "nan"])).toEqual([{ start: 1, end: 5 }]);
    expect(highlightParts({ text: "a big cat", ranges: [{ start: 2, end: 5 }] })).toEqual([
      { text: "a ", hit: false },
      { text: "big", hit: true },
      { text: " cat", hit: false },
    ]);
  });
});
