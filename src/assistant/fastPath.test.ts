import { describe, expect, it } from "vitest";
import { convert, dateAnswer, fastPath, parseDay, sum } from "./fastPath";

// Monday 16 Nov 2026, 10:00.
const now = new Date(2026, 10, 16, 10, 0);

describe("parseDay", () => {
  it("reads relative days", () => {
    expect(parseDay("today", now)).toBe("2026-11-16");
    expect(parseDay("yesterday", now)).toBe("2026-11-15");
    expect(parseDay("3 days ago", now)).toBe("2026-11-13");
    expect(parseDay("a week ago", now)).toBe("2026-11-09");
    expect(parseDay("in 2 days", now)).toBe("2026-11-18");
    expect(parseDay("last monday", now)).toBe("2026-11-09");
    expect(parseDay("next friday", now)).toBe("2026-11-20");
    expect(parseDay("saturday", now)).toBe("2026-11-14");
  });
  it("reads dates", () => {
    expect(parseDay("3 nov", now)).toBe("2026-11-03");
    expect(parseDay("Nov 3rd", now)).toBe("2026-11-03");
    expect(parseDay("3 november 2025", now)).toBe("2025-11-03");
    expect(parseDay("3/11", now)).toBe("2026-11-03");
    expect(parseDay("2026-01-05", now)).toBe("2026-01-05");
    // Far ahead with no year: last year's.
    expect(parseDay("5 march", now)).toBe("2026-03-05");
    expect(parseDay("31 feb", now)).toBeNull();
    expect(parseDay("my cat", now)).toBeNull();
  });
});

describe("fastPath", () => {
  it("opens days and pages, in a new tab when asked", () => {
    expect(fastPath("yesterday", now)).toMatchObject({ kind: "open", day: "2026-11-15", newTab: false });
    expect(fastPath("open 3 nov in a new tab", now)).toMatchObject({ kind: "open", day: "2026-11-03", newTab: true });
    expect(fastPath("go to [[Work log]]", now)).toMatchObject({ kind: "open", page: "Work log" });
    expect(fastPath("open Work log", now)).toMatchObject({ kind: "open", page: "Work log" });
    expect(fastPath("today's end", now)).toMatchObject({ kind: "open", day: "2026-11-16", end: true });
  });
  it("leaves real requests to the AI", () => {
    expect(fastPath("open the 3rd day of my college and summarise it", now)).toBeNull();
    expect(fastPath("make a table of my top tags", now)).toBeNull();
    expect(fastPath("remind me to call mom at 6", now)).toBeNull();
  });
  it("answers sums, units and dates", () => {
    expect(fastPath("23 by 67", now)).toEqual({ kind: "answer", text: "23 by 67 = 1541" });
    expect(sum("15% of 240")).toBe("15% of 240 = 36");
    expect(sum("what is 2 + 2 * 3")).toBe("what is 2 + 2 * 3 = 8");
    expect(sum("square root of 81")).toMatch(/= 9$/);
    expect(sum("hello")).toBeNull();
    expect(convert("5 km in miles")).toBe("5 km = 3.107 miles");
    expect(convert("30 degrees c to f")).toBe("30 °C = 86 °F");
    expect(convert("70 kg to lb")).toBe("70 kg = 154.3 lb");
    expect(convert("5 km in kg")).toBeNull();
    expect(dateAnswer("days until 25 dec", now)).toBe("39 days until Friday 25 December 2026");
    expect(dateAnswer("days since 1 jan", now)).toBe("319 days since Thursday 1 January 2026");
    expect(dateAnswer("what day is 3 nov 2027", now)).toBe("Wednesday 3 November 2027");
  });
});
