import { describe, expect, it } from "vitest";
import { skyAt, skyForStamp } from "./sky";
import { RAJKOT } from "./solar";
import { formatTimestamp, TIMESTAMP_RE } from "./timestamp";

// Moments in India Standard Time (UTC+5:30), whatever zone the tests run in.
const ist = (y: number, m: number, d: number, h: number, min = 0) => Date.UTC(y, m - 1, d, h, min) - 5.5 * 3_600_000;
const sky = (y: number, m: number, d: number, h: number, min = 0) => skyAt(ist(y, m, d, h, min), RAJKOT);

describe("skyAt (Rajkot, the real sun)", () => {
  it("follows the sky through a November day", () => {
    expect(sky(2026, 11, 4, 2)).toMatchObject({ phase: "night", icon: "🌙" });
    expect(sky(2026, 11, 4, 6, 40)).toMatchObject({ phase: "dawn", icon: "🌅" });
    expect(sky(2026, 11, 4, 12, 30)).toMatchObject({ phase: "day", icon: "☀️" });
    expect(sky(2026, 11, 4, 17, 55)).toMatchObject({ phase: "sunset", icon: "🌇" });
    expect(sky(2026, 11, 4, 19, 30)).toMatchObject({ phase: "night", icon: "🌙" });
  });

  it("shifts with the seasons: 07:00 is dawn in winter, full morning in summer; 19:15 is sunset in June, night in December", () => {
    expect(sky(2026, 12, 21, 7, 0).phase).toBe("dawn");
    expect(sky(2026, 6, 21, 7, 0).phase).toBe("day");
    expect(sky(2026, 6, 21, 19, 15).phase).toBe("sunset");
    expect(sky(2026, 12, 21, 19, 15).phase).toBe("night");
  });

  it("gets darker blue as the evening goes on", () => {
    const blue = (h: number, m: number) => parseInt(sky(2026, 11, 4, h, m).bg.slice(5, 7), 16);
    expect(blue(18, 25)).toBeGreaterThan(blue(18, 50));
    expect(blue(18, 50)).toBeGreaterThan(blue(20, 0));
  });

  it("picks readable text: dark on light skies, light on dark skies", () => {
    expect(sky(2026, 11, 4, 12, 30).fg).toBe("#3a2a12");
    expect(sky(2026, 11, 4, 0).fg).toBe("#f4f7ff");
    for (let h = 0; h < 24; h++) expect(sky(2026, 11, 4, h).bg).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("reads a timestamp's own date", () => {
    expect(skyForStamp("4", "November", "2026", "12", "30")).toEqual(skyAt(new Date(2026, 10, 4, 12, 30)));
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
