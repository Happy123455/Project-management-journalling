import { describe, expect, it } from "vitest";
import { cleanInfo, infoLabel } from "./blockInfo";

describe("block info", () => {
  it("drops empty entries and trims", () => {
    expect(cleanInfo({ " Mood ": " happy ", Place: "", "": "x" })).toEqual({ Mood: "happy" });
    expect(cleanInfo({ a: " " })).toBeNull();
    expect(cleanInfo(null)).toBeNull();
  });

  it("labels info for display", () => {
    expect(infoLabel({ Mood: "happy", Place: "home" })).toBe("Mood: happy · Place: home");
  });
});
