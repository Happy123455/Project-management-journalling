import { describe, expect, it } from "vitest";
import { cleanLatex, latexToPlain } from "./latex";
import { answerFor, evaluate, variablesIn } from "./mathEval";

describe("latex for the calculator", () => {
  it("reads fractions, roots, powers and symbols", () => {
    expect(evaluate(latexToPlain("\\frac{1}{2} + \\sqrt{16}"))).toBe(4.5);
    expect(evaluate(latexToPlain("2^{10} \\cdot 3"))).toBe(3072);
    expect(evaluate(latexToPlain("\\frac{\\frac{1}{2}}{4}"))).toBe(0.125);
    expect(evaluate(latexToPlain("\\sqrt[3]{27}"))).toBeCloseTo(3);
    expect(evaluate(latexToPlain("\\left(2+3\\right)\\times 4"))).toBe(20);
  });
  it("math blocks define variables the text can use", () => {
    const vars = variablesIn([latexToPlain("r = 3"), latexToPlain("A = \\pi r^{2}")]);
    expect(vars.get("A")).toBeCloseTo(28.2743, 3);
    expect(answerFor("A*2", vars)).toBe("56.5486677646");
  });
  it("cleans AI answers", () => {
    expect(cleanLatex("```latex\n\\frac{a}{b}\n```")).toBe("\\frac{a}{b}");
    expect(cleanLatex("$$x^2$$")).toBe("x^2");
    expect(cleanLatex("\\[ y = 2 \\]")).toBe("y = 2");
  });
});
