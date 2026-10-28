import { describe, expect, it } from "vitest";
import { extractLinks } from "./links";

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
});
