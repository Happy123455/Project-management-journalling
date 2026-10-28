import { describe, expect, it } from "vitest";
import { placeBar } from "./placement";

const bar = { width: 240, height: 36 };
const screen = { width: 390, height: 800 };

describe("placeBar", () => {
  it("centres the bar above the picture", () => {
    expect(placeBar({ left: 95, top: 300, width: 200, height: 150 }, bar, screen)).toEqual({ x: -20, y: -42, flipped: false });
  });

  it("slides the bar inside the screen at the left and right edges", () => {
    expect(placeBar({ left: 0, top: 300, width: 100, height: 80 }, bar, screen).x).toBe(8);
    const right = placeBar({ left: 300, top: 300, width: 90, height: 80 }, bar, screen);
    expect(300 + right.x + bar.width).toBe(390 - 8);
  });

  it("flips below the picture when there's no room above", () => {
    expect(placeBar({ left: 95, top: 20, width: 200, height: 150 }, bar, screen)).toEqual({ x: -20, y: 156, flipped: true });
  });

  it("keeps clear of the status bar", () => {
    const p = placeBar({ left: 95, top: 60, width: 200, height: 700 }, bar, { ...screen, top: 40 });
    expect(60 + p.y).toBeGreaterThanOrEqual(48);
  });
});
