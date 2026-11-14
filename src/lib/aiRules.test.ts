import { describe, expect, it } from "vitest";
import { dueRule, firedKey, parseRule, parseRules, targetDay } from "./aiRules";

describe("AI navigation rules", () => {
  it("reads rules written in plain ways", () => {
    expect(parseRule("weekdays 09:00 open [[Work log]]")).toMatchObject({ days: [1, 2, 3, 4, 5], when: { kind: "time", minutes: 540 }, target: "Work log" });
    expect(parseRule("on open → today")).toMatchObject({ days: [], when: { kind: "open" }, target: "today" });
    expect(parseRule("sat, sun 10:30 → [[Weekend plans]]")).toMatchObject({ days: [0, 6], when: { minutes: 630 } });
    expect(parseRule("- 9.30pm open the project Fitness")).toMatchObject({ when: { minutes: 21 * 60 + 30 }, target: "Fitness" });
    expect(parseRule("when the app opens go to [[Inbox]]")).toMatchObject({ when: { kind: "open" }, target: "Inbox" });
    expect(parseRule("Buy milk")).toBeNull();
    expect(parseRule("someday 09:00 open X")).toBeNull();
    expect(parseRule("25:00 open X")).toBeNull();
  });

  it("follows the right rule at the right time, once a day", () => {
    const rules = parseRules(["on open → today", "weekdays 09:00 open [[Work log]]", "weekdays 11:00 open [[Standup]]", "sat 10:00 → [[Weekend]]"]);
    const fri = (h: number, m = 0) => new Date(2026, 10, 13, h, m);
    // Just opened at 11:30 on a Friday: the latest due time rule beats "on open".
    expect(dueRule(rules, fri(11, 30), true, new Set())?.target).toBe("Standup");
    // Already open at 11:30: only right at the minute.
    expect(dueRule(rules, fri(11, 30), false, new Set())).toBeNull();
    expect(dueRule(rules, fri(11, 0), false, new Set())?.target).toBe("Standup");
    // Opened early: "on open".
    expect(dueRule(rules, fri(7, 0), true, new Set())?.target).toBe("today");
    // Once a day.
    const r = dueRule(rules, fri(9, 0), false, new Set())!;
    expect(dueRule(rules, fri(9, 1), false, new Set([firedKey(r, fri(9, 0))]))).toBeNull();
    // Saturday only gets its own (and on open).
    expect(dueRule(rules, new Date(2026, 10, 14, 10, 0), false, new Set())?.target).toBe("Weekend");
  });

  it("relative days", () => {
    const now = new Date(2026, 10, 14, 12);
    expect(targetDay("today", now)).toBe("2026-11-14");
    expect(targetDay("Tomorrow", now)).toBe("2026-11-15");
    expect(targetDay("2026-01-02", now)).toBe("2026-01-02");
    expect(targetDay("Work log", now)).toBeNull();
  });
});
