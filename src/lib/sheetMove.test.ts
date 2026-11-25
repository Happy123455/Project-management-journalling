import { describe, expect, it } from "vitest";
import { moveLine } from "./sheet";

describe("moveLine", () => {
  it("moves a row with its formulas following", () => {
    const d = { v: 1 as const, rows: 3, cols: 2, cells: { A1: "a", A2: "b", A3: "=A1&A2", B3: "x" } };
    const m = moveLine(d, "row", 2, 0);
    expect(m.cells).toEqual({ A1: "=A2&A3", B1: "x", A2: "a", A3: "b" });
  });
  it("moves a column and its width", () => {
    const d = { v: 1 as const, rows: 1, cols: 3, cells: { A1: "1", B1: "2", C1: "=A1+B1" }, widths: [10, 20, 30] };
    const m = moveLine(d, "col", 0, 2);
    expect(m.cells).toEqual({ C1: "1", A1: "2", B1: "=C1+A1" });
    expect(m.widths).toEqual([20, 30, 10]);
  });
});
