// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { activeTab, canGo, closeTab, currentLoc, go, initialTabs, loadTabs, openTab, saveTabs, switchTab, visit, type Loc } from "./tabs";

const day = (d: string): Loc => ({ kind: "day", day: d });
const page = (title: string): Loc => ({ kind: "page", title });

describe("tabs", () => {
  beforeEach(() => localStorage.clear());

  it("goes back and forward through what was opened", () => {
    let s = initialTabs(day("2026-11-05"));
    s = visit(s, page("Journal"));
    s = visit(s, day("2026-11-04"));
    expect(canGo(s, 1)).toBe(false);
    const back = go(s, -1)!;
    expect(back.loc).toEqual(page("Journal"));
    // Showing that place records nothing new.
    expect(visit(back.state, page("journal"))).toBe(back.state);
    const fwd = go(back.state, 1)!;
    expect(fwd.loc).toEqual(day("2026-11-04"));
    // Opening something new after going back drops what was "forward".
    const branched = visit(go(go(fwd.state, -1)!.state, -1)!.state, page("Gym"));
    expect(activeTab(branched).history).toEqual([day("2026-11-05"), page("Gym")]);
    expect(canGo(branched, 1)).toBe(false);
  });

  it("keeps a separate history per tab, and closing moves to a neighbour", () => {
    let s = initialTabs(day("2026-11-05"));
    const first = s.active;
    s = openTab(s, page("Journal"));
    s = visit(s, page("Gym"));
    expect(s.tabs).toHaveLength(2);
    expect(currentLoc(activeTab(switchTab(s, first)))).toEqual(day("2026-11-05"));
    s = closeTab(s, s.active);
    expect(s.active).toBe(first);
    expect(closeTab(s, first)).toBe(s);
  });

  it("is kept on the device and survives bad data", () => {
    const s = openTab(initialTabs(day("2026-11-05")), page("Journal"));
    saveTabs(s);
    expect(loadTabs(day("2026-01-01"))).toEqual(s);
    localStorage.setItem("journal.tabs", '{"tabs":[{"id":"x","history":[{"kind":"day","day":"bad"}]}]}');
    expect(currentLoc(activeTab(loadTabs(day("2026-01-01"))))).toEqual(day("2026-01-01"));
  });
});
