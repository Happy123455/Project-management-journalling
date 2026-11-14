import { describe, expect, it } from "vitest";
import { display, evaluate, fill, parseSheet, setCells, sheetForAi, sheetText, shiftFormula, type SheetData } from "./sheet";

const sheet = (cells: Record<string, string>, rows = 6, cols = 4): SheetData => ({ v: 1, rows, cols, cells });
const val = (d: SheetData, ref: string) => display(evaluate(d).get(ref));

describe("sheet formulas", () => {
  it("arithmetic, precedence, refs and ranges", () => {
    const d = sheet({ A1: "2", A2: "3", A3: "1,200", B1: "=A1+A2*2", B2: "=(A1+A2)^2", B3: "=SUM(A1:A3)", B4: "=AVERAGE(A1:A2)", C1: "=-A1%", C2: "10%" });
    expect(val(d, "B1")).toBe("8");
    expect(val(d, "B2")).toBe("25");
    expect(val(d, "B3")).toBe("1205");
    expect(val(d, "B4")).toBe("2.5");
    expect(val(d, "C1")).toBe("-0.02");
    expect(val(d, "C2")).toBe("0.1");
  });

  it("IF, comparisons, text, SUMIF/COUNTIF, errors and cycles", () => {
    const d = sheet({
      A1: "5", A2: "12", A3: "apple",
      B1: '=IF(A1>3,"big","small")', B2: '=A3&" pie"', B3: '=COUNTIF(A1:A3,">4")', B4: '=SUMIF(A1:A2,">=10")',
      C1: "=A1/0", C2: "=C3+1", C3: "=C2+1", C4: "=NOPE(1)", D1: "=IFERROR(C1,0)", D2: "=ROUND(2.345,2)", D3: "=A3+1", D4: "=MAX(A1:A3)",
    });
    expect(val(d, "B1")).toBe("big");
    expect(val(d, "B2")).toBe("apple pie");
    expect(val(d, "B3")).toBe("2");
    expect(val(d, "B4")).toBe("12");
    expect(val(d, "C1")).toBe("#DIV/0!");
    expect(val(d, "C2")).toBe("#CYCLE!");
    expect(val(d, "C4")).toBe("#NAME?");
    expect(val(d, "D1")).toBe("0");
    expect(val(d, "D2")).toBe("2.35");
    expect(val(d, "D3")).toBe("#VALUE!");
    expect(val(d, "D4")).toBe("12");
  });

  it("shifts relative references only, never inside quotes", () => {
    expect(shiftFormula("=A1+$B$2+C$3+$D4", 2, 1)).toBe("=B3+$B$2+D$3+$D6");
    expect(shiftFormula('=IF(A1>0,"A1",SUM(A1:A3))', 1, 0)).toBe('=IF(A2>0,"A1",SUM(A2:A4))');
    expect(shiftFormula("=A1", -1, 0)).toBe("=#REF!");
    expect(shiftFormula("12", 1, 1)).toBe("12");
  });

  it("fill: series, counted text, copies and formulas, down and across", () => {
    let d = sheet({ A1: "1", A2: "3", B1: "Item 1", C1: "=A1*2", D1: "x" });
    d = fill(d, { r0: 0, c0: 0, r1: 1, c1: 0 }, { r0: 0, c0: 0, r1: 4, c1: 0 });
    expect([1, 2, 3, 4, 5].map((r) => d.cells[`A${r}`])).toEqual(["1", "3", "5", "7", "9"]);
    d = fill(d, { r0: 0, c0: 1, r1: 0, c1: 3 }, { r0: 0, c0: 1, r1: 2, c1: 3 });
    expect([d.cells.B2, d.cells.B3, d.cells.C2, d.cells.C3, d.cells.D3]).toEqual(["Item 2", "Item 3", "=A2*2", "=A3*2", "x"]);
    expect(val(d, "C3")).toBe("10");
    const across = fill(sheet({ A1: "Mon" }), { r0: 0, c0: 0, r1: 0, c1: 0 }, { r0: 0, c0: 0, r1: 0, c1: 5 });
    expect(across.cells.F1).toBe("Mon");
    expect(across.cols).toBe(6);
  });

  it("reads stored data safely, sets cells, and reads out for search and the AI", () => {
    expect(parseSheet("not json")).toMatchObject({ rows: 4, cols: 4, cells: {} });
    expect(parseSheet({ rows: 9999, cols: 2, cells: { a1: 3, ZZZ9: "x" } })).toMatchObject({ rows: 500, cells: { A1: "3" } });
    const d = setCells(sheet({}, 2, 2), { A1: "4", B1: "5", C3: "=A1+B1" }) as SheetData;
    expect(d.rows).toBe(3);
    expect(d.cols).toBe(3);
    expect(sheetText(d)).toBe("4\t5\n\n\t\t9");
    expect(sheetForAi(d)).toContain("C3: =A1+B1 → 9");
    expect(setCells(d, { "A 1": "x" })).toMatch(/isn't a cell/);
  });
});
