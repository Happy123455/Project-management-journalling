import { describe, expect, it } from "vitest";
import { outlineDoc, parseOutline } from "./outline";

describe("parseOutline", () => {
  it("nests by indent and skips prose", () => {
    const t = parseOutline("Here you go:\n- Root\n  - **A**\n    - a1\n  - B\n- Other");
    expect(t.map((n) => n.text)).toEqual(["Root", "Other"]);
    expect(t[0].children.map((n) => n.text)).toEqual(["A", "B"]);
    expect(t[0].children[0].children[0].text).toBe("a1");
    expect(outlineDoc(t).content?.[0].content?.[1].type).toBe("bulletList");
  });
});
