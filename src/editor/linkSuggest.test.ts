import { describe, expect, it } from "vitest";
import { linkOptions } from "./linkSuggest";

describe("linkOptions", () => {
  const names = ["Anu", "Project Ravi", "Ravi", "Ravindra"];

  it("puts names starting with the query first, then names containing it", () => {
    expect(linkOptions(names, "rav").map((o) => o.name)).toEqual(["Ravi", "Ravindra", "Project Ravi", "rav"]);
  });

  it("offers to create a new page only when no name matches exactly", () => {
    expect(linkOptions(names, "ravi").some((o) => o.isNew)).toBe(false);
    expect(linkOptions(names, "Meera")).toEqual([{ name: "Meera", isNew: true }]);
  });

  it("lists names before anything is typed", () => {
    expect(linkOptions(names, "")).toHaveLength(4);
  });
});
