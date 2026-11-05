import { describe, expect, it } from "vitest";
import { daysShown } from "./Menu";
import { countTargets } from "./Panels";

describe("menu lists", () => {
  const days = ["2026-11-01", "2026-11-03", "2026-11-09", "2026-10-20", "2026-11-02"];
  const written = new Set(["2026-11-01", "2026-11-03", "2026-11-09", "2026-10-20"]);
  it("Past shows only today and before, today first then back in time", () => {
    expect(daysShown(days, { today: "2026-11-05", day: "2026-11-09", written, sort: "past" })).toEqual(["2026-11-05", "2026-11-03", "2026-11-01", "2026-10-20"]);
    expect(daysShown(days, { today: "2026-11-05", day: "2026-11-05", written, sort: "new" })[0]).toBe("2026-11-09");
    expect(daysShown(days, { today: "2026-11-05", day: "2026-11-05", written, sort: "old" })[0]).toBe("2026-10-20");
  });
  it("counts every link and tag in the journal once per note, any letter case", () => {
    const rows = [
      { target: "Journal", kind: "wikilink" as const },
      { target: "journal", kind: "wikilink" as const },
      { target: "Gym", kind: "wikilink" as const },
      { target: "idea", kind: "tag" as const },
    ];
    expect(countTargets(rows, "wikilink")).toEqual([{ name: "Gym", count: 1 }, { name: "Journal", count: 2 }]);
    expect(countTargets(rows, "tag")).toEqual([{ name: "idea", count: 1 }]);
  });
});
