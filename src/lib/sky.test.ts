import { describe, expect, it } from "vitest";
import { skyFor } from "./sky";
import { formatTimestamp, TIMESTAMP_RE } from "./timestamp";

describe("skyFor", () => {
  it("has a colour for every hour", () => {
    for (let h = 0; h < 24; h++) expect(skyFor(h).bg).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("follows the sky through the day", () => {
    expect(skyFor(2)).toMatchObject({ phase: "night", icon: "🌙" });
    expect(skyFor(5)).toMatchObject({ phase: "dawn", icon: "🌅", bg: "#f4a6b8" });
    expect(skyFor(12)).toMatchObject({ phase: "day", icon: "☀️" });
    expect(skyFor(18)).toMatchObject({ phase: "sunset", icon: "🌇" });
    expect(skyFor(20)).toMatchObject({ phase: "night", icon: "🌙" });
  });

  it("gets darker blue as the night goes on", () => {
    const lightness = (h: number) => parseInt(skyFor(h).bg.slice(5, 7), 16);
    expect(lightness(19)).toBeGreaterThan(lightness(21));
    expect(lightness(21)).toBeGreaterThan(lightness(23));
  });

  it("picks readable text: dark on light skies, light on dark skies", () => {
    expect(skyFor(12).fg).toBe("#3a2a12");
    expect(skyFor(0).fg).toBe("#f4f7ff");
  });

  it("wraps hours outside 0–23", () => {
    expect(skyFor(24)).toEqual(skyFor(0));
    expect(skyFor(-1)).toEqual(skyFor(23));
  });
});

describe("TIMESTAMP_RE", () => {
  it("finds timestamps and their hour and minute", () => {
    const text = `met Ravi ${formatTimestamp(new Date(2026, 9, 28, 10, 55, 51))} then lunch`;
    const [m] = [...text.matchAll(TIMESTAMP_RE)];
    expect(m[0]).toBe("28,October,2026 Wednesday (10:55:51)");
    expect([m[5], m[6]]).toEqual(["10", "55"]);
  });
});
