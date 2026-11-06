import { describe, expect, it } from "vitest";
import { RAJKOT, sunElevation, sunTimes } from "./solar";

// India Standard Time is UTC+5:30, so these hold whatever zone the tests run in.
const ist = (y: number, m: number, d: number, h: number, min: number) => Date.UTC(y, m - 1, d, h, min) - 5.5 * 3_600_000;
const near = (got: number, want: number, minutes = 4) => expect(Math.abs(got - want) / 60_000).toBeLessThan(minutes);

describe("sun times for Rajkot", () => {
  it("winter: late sunrise, early sunset", () => {
    const s = sunTimes(ist(2026, 12, 21, 12, 0), RAJKOT);
    near(s.rise, ist(2026, 12, 21, 7, 20));
    near(s.set, ist(2026, 12, 21, 18, 5));
  });
  it("summer: early sunrise, late sunset", () => {
    const s = sunTimes(ist(2026, 6, 21, 12, 0), RAJKOT);
    near(s.rise, ist(2026, 6, 21, 6, 3));
    near(s.set, ist(2026, 6, 21, 19, 32));
  });
  it("noon is ~12:40 and dawn/dusk wrap sunrise/sunset", () => {
    const s = sunTimes(ist(2026, 11, 4, 9, 0), RAJKOT);
    near(s.noon, ist(2026, 11, 4, 12, 31), 6);
    expect(s.nightEnd).toBeLessThan(s.dawn);
    expect(s.dawn).toBeLessThan(s.rise);
    expect(s.set).toBeLessThan(s.dusk);
    expect(s.dusk).toBeLessThan(s.nightStart);
    expect(s.noonElevation).toBeGreaterThan(45);
    expect(s.noonElevation).toBeLessThan(55);
  });
  it("elevation is below the horizon at midnight and high at noon", () => {
    expect(sunElevation(ist(2026, 11, 4, 0, 0))).toBeLessThan(-40);
    expect(sunElevation(ist(2026, 11, 4, 12, 30))).toBeGreaterThan(45);
  });
});
