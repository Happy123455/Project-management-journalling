import { describe, expect, it } from "vitest";
import katex from "katex";
import { displayLatex, FORMULAS, inlineFormulas, niceRange, niceStep, plainToLatex, sample, workingFor } from "./mathSmart";
import { evaluate, variablesIn } from "./mathEval";

describe("plain maths to a formula", () => {
  it("draws fractions, powers and roots", () => {
    expect(plainToLatex("(a+b+c+d)/2")).toBe("\\frac{a + b + c + d}{2}");
    expect(plainToLatex("x^2 + sqrt(y)")).toBe("x^{2} + \\sqrt{y}");
    expect(plainToLatex("v = u + a*t")).toBe("v = u + a \\cdot t");
    expect(plainToLatex("2x + 3")).toBe("2x + 3");
    expect(plainToLatex("2*pi*r")).toBe("2\\pi \\cdot r");
    expect(plainToLatex("mu*N")).toBe("\\mu \\cdot N");
    expect(plainToLatex("hello world!")).toBeNull();
  });
  it("leaves LaTeX alone and every library formula renders", () => {
    expect(displayLatex("\\frac{1}{2}")).toBe("\\frac{1}{2}");
    for (const f of FORMULAS) {
      const tex = plainToLatex(f.plain);
      expect(tex, f.name).not.toBeNull();
      expect(() => katex.renderToString(tex!, { throwOnError: true }), f.name).not.toThrow();
    }
  });
  it("finds formulas in running text but not dates, words or links", () => {
    const hits = inlineFormulas("half the sum is (a+b+c+d)/2, and x^2+1 too.");
    expect(hits.map((h) => h.latex)).toEqual(["\\frac{a + b + c + d}{2}", "x^{2} + 1"]);
    expect(inlineFormulas("met on 4/11/2026 and/or later, see https://x.io/a^2 or 50/50")).toEqual([]);
  });
});

describe("working, wheels and charts", () => {
  it("shows the working step by step", () => {
    const vars = variablesIn(["m = 5", "g = 9.8"]);
    expect(workingFor("W = m*g", vars)).toEqual({ steps: ["W = m*g", "m = 5, g = 9.8", "W = (5)*(9.8)", "W = 49"], answer: "W = 49" });
  });
  it("picks tidy steps and ranges", () => {
    expect(niceStep(1.2)).toBeCloseTo(0.1);
    expect(niceStep(50)).toBe(1);
    expect(niceRange(5)).toEqual([0, 10]);
  });
  it("samples a curve", () => {
    const pts = sample("x^2", new Map(), "x", -2, 2, 4);
    expect(pts).toEqual([[-2, 4], [-1, 1], [0, 0], [1, 1], [2, 4]]);
    expect(evaluate("pi*r^2", new Map([["r", 1]]))).toBeCloseTo(Math.PI);
  });
});
