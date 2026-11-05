import { describe, expect, it } from "vitest";
import { matchTitles } from "./titleMatch";

describe("title search", () => {
  const pages = ["Journal", "Gym plan", "Mom"];
  const days = ["2026-11-04", "2026-11-05", "2025-11-05"];
  it("looks at titles only, pages first, newest days first", () => {
    expect(matchTitles("jour", pages, days, "2026-11-05").map((h) => h.key)).toEqual(["Journal"]);
    expect(matchTitles("november 5", pages, days, "2026-11-05").map((h) => h.key)).toEqual(["2026-11-05", "2025-11-05"]);
    expect(matchTitles("today", pages, days, "2026-11-05").map((h) => h.key)).toEqual(["2026-11-05"]);
    expect(matchTitles("2026-11", pages, days, "2026-11-05").map((h) => h.key)).toEqual(["2026-11-05", "2026-11-04"]);
    expect(matchTitles("m", pages, days, "2026-11-05")[0].key).toBe("Mom");
    expect(matchTitles("  ", pages, days, "2026-11-05")).toEqual([]);
  });
});
