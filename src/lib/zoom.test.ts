import { describe, expect, it } from "vitest";
import { clampPan, toggleZoom, zoomAt } from "./zoom";

const start = { scale: 1, x: 0, y: 0 };

describe("zoom", () => {
  it("keeps the point under the fingers fixed while zooming", () => {
    const v = zoomAt(start, 2, { x: 100, y: 50 });
    expect(v).toEqual({ scale: 2, x: -100, y: -50 });
    // the content point that was at (100, 50) is still there: x + 100 * scale... = 100
    expect(v.x + 100 * v.scale).toBe(100);
  });

  it("limits the zoom and snaps back to fit at 1×", () => {
    expect(zoomAt(start, 20, { x: 0, y: 0 }).scale).toBe(6);
    expect(zoomAt({ scale: 3, x: 40, y: 10 }, 0.5, { x: 0, y: 0 })).toEqual(start);
  });

  it("double-tap zooms in, and out again", () => {
    const zoomed = toggleZoom(start, { x: 0, y: 0 });
    expect(zoomed.scale).toBe(2.5);
    expect(toggleZoom(zoomed, { x: 10, y: 10 })).toEqual(start);
  });

  it("stops panning at the picture's edges", () => {
    expect(clampPan({ scale: 2, x: 500, y: -500 }, { width: 400, height: 300 })).toEqual({ scale: 2, x: 200, y: -150 });
  });
});
