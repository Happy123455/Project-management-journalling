import { describe, expect, it } from "vitest";
import { extractLinks, linesMentioning, uniqueNames } from "./links";

describe("extractLinks", () => {
  it("finds wikilinks with and without aliases", () => {
    expect(extractLinks("met [[Ravi Shah]] and [[Project X|the app]]").wikilinks).toEqual([
      "Ravi Shah",
      "Project X",
    ]);
  });

  it("finds tags, including nested ones", () => {
    expect(extractLinks("#idea and #project/journal today").tags).toEqual(["idea", "project/journal"]);
  });

  it("ignores digit-only tags, headings and mid-word hashes", () => {
    expect(extractLinks("issue #123, C# code, a#b").tags).toEqual([]);
  });

  it("deduplicates", () => {
    expect(extractLinks("#a #a [[X]] [[X]]")).toEqual({ wikilinks: ["X"], tags: ["a"] });
  });

  it("picks the lines that mention a page or tag", () => {
    const text = "met [[Ravi]] today\nlunch\n#work with [[ravi|R]]\n#workshop";
    expect(linesMentioning(text, "wikilink", "Ravi")).toEqual(["met [[Ravi]] today", "#work with [[ravi|R]]"]);
    expect(linesMentioning(text, "tag", "work")).toEqual(["#work with [[ravi|R]]"]);
  });

  it("dedupes names ignoring letter case", () => {
    expect(uniqueNames(["ravi", "Ravi", "Anu"])).toEqual(["Anu", "ravi"]);
  });
});
