import { describe, expect, it } from "vitest";
import { softLightAt } from "./softLight";

const H = 3600_000;
const day = Date.UTC(2026, 10, 2);
const rise = day + 6 * H;
const set = day + 18 * H;

describe("softLightAt", () => {
  it("morning sun on the left casts shadows to the right, long and warm", () => {
    const l = softLightAt(rise + 1 * H, rise, set, "clear");
    expect(l.phase).toBe("day");
    expect(l.x).toBeGreaterThan(4);
    expect(l.sunX).toBeLessThan(30);
    expect(l.tintAmt).toBeGreaterThan(5);
  });
  it("noon casts short shadows straight down", () => {
    const l = softLightAt(day + 12 * H, rise, set, "clear");
    expect(Math.abs(l.x)).toBeLessThan(0.5);
    expect(l.y).toBeGreaterThan(5);
    const morning = softLightAt(rise + 1 * H, rise, set, "clear");
    expect(Math.hypot(l.x, l.y)).toBeLessThan(Math.hypot(morning.x, morning.y));
  });
  it("evening sun on the right casts shadows to the left", () => {
    const l = softLightAt(set - 1 * H, rise, set, "clear");
    expect(l.x).toBeLessThan(-4);
    expect(l.sunX).toBeGreaterThan(70);
  });
  it("twilight glows on the sun's side; night is faint moonlight", () => {
    expect(softLightAt(set + 0.25 * H, rise, set, "clear").x).toBeLessThan(0);
    expect(softLightAt(rise - 0.25 * H, rise, set, "clear").x).toBeGreaterThan(0);
    const night = softLightAt(day + 23 * H, rise, set, "clear");
    expect(night.phase).toBe("night");
    expect(night.strength).toBeLessThan(0.7);
    expect(softLightAt(day + 2 * H, rise, set, "clear").phase).toBe("night");
  });
  it("clouds and rain make shadows shorter, softer and fainter", () => {
    const t = day + 10 * H;
    const clear = softLightAt(t, rise, set, "clear");
    const cloudy = softLightAt(t, rise, set, "cloudy");
    const rain = softLightAt(t, rise, set, "rain");
    expect(Math.hypot(cloudy.x, cloudy.y)).toBeLessThan(Math.hypot(clear.x, clear.y));
    expect(rain.blur).toBeGreaterThan(clear.blur);
    expect(rain.strength).toBeLessThan(clear.strength);
  });

  it("the surface is soft by day (never white), dims at a low sun and is dark at night", () => {
    const lum = (hex: string) => parseInt(hex.slice(1, 3), 16) + parseInt(hex.slice(3, 5), 16) + parseInt(hex.slice(5, 7), 16);
    const noon = softLightAt(day + 12 * H, rise, set, "clear");
    const low = softLightAt(rise + 0.5 * H, rise, set, "clear");
    const night = softLightAt(day + 23 * H, rise, set, "clear");
    expect(noon.tone).toBe("light");
    expect(lum(noon.base)).toBeLessThan(3 * 235);
    expect(lum(low.base)).toBeLessThan(lum(noon.base));
    expect(night.tone).toBe("dark");
    expect(lum(night.base)).toBeLessThan(3 * 60);
    expect(softLightAt(set + 0.2 * H, rise, set, "clear").tone).toBe("dark");
  });
});
