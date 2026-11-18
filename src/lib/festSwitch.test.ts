import { expect, it } from "vitest";
import { specialsOn } from "./specialDates";
import { shownFestGroups } from "./editorPrefs";
it("the Year view's festival switch hides every festival", () => {
  const on = { india: true, world: true, fun: true };
  expect(specialsOn("2026-11-08", [], on).length).toBeGreaterThan(0);
  const off = shownFestGroups({ festGroups: on, festivalsOn: false } as never);
  for (const d of ["2026-11-08", "2026-11-26", "2026-12-25", "2026-01-01", "2026-10-31"]) expect(specialsOn(d, [], off)).toEqual([]);
});
