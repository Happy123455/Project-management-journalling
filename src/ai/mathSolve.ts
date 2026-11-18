import { askAi } from "./client";
import { formatAnswer } from "../lib/mathEval";

/**
 * The math assistant (🤖 on a math block, and the ✦ agent's math_solve): a problem or a request
 * for a formula in words → named values, a formula in plain calculator maths, the working and
 * the answer. `source` is what goes into the math block (one definition per line, then the formula).
 */
export const SOLVE_SYSTEM =
  "You are a careful maths tutor inside a journal app. The user describes a problem or asks for a formula in plain words. " +
  "Work it out exactly and check the arithmetic. Reply in JSON. " +
  "'variables': each known quantity as a short name (one letter, or letter_subscript like v_0), its number and what it means (with unit). " +
  "'formula': the formula that gives the answer in PLAIN calculator syntax using only those names, numbers, + - * / ^ ( ) and sqrt(), sin(), cos(), tan(), ln(), log(), abs(), pi; " +
  "written as 'name = expression' (e.g. 's = u*t + 1/2*a*t^2'); empty if the problem has no single formula. " +
  "'steps': the working, one short line per step, plain text maths (no LaTeX). 'answer': the final answer with its unit, one line.";

export const SOLVE_SCHEMA = {
  type: "object",
  properties: {
    variables: { type: "array", items: { type: "object", properties: { name: { type: "string" }, value: { type: "number" }, meaning: { type: "string" } }, required: ["name", "value", "meaning"] } },
    formula: { type: "string" },
    steps: { type: "array", items: { type: "string" } },
    answer: { type: "string" },
  },
  required: ["variables", "formula", "steps", "answer"],
};


export interface MathSolution {
  prompt: string;
  steps: string[];
  answer: string;
}

export async function solveMath(question: string): Promise<{ source: string; solution: MathSolution }> {
  const a = await askAi<{ variables: { name: string; value: number; meaning: string }[]; formula: string; steps: string[]; answer: string }>({
    task: "organise",
    cloud: true,
    system: SOLVE_SYSTEM,
    text: question,
    schema: SOLVE_SCHEMA,
    maxTokens: 3000,
  });
  const j = a.json;
  const clean = (s: string) => s.replace(/[\u00d7\u00b7]/g, "*").replace(/[\u2212]/g, "-").replace(/\$/g, "").trim();
  const vars = (j.variables ?? []).filter((v) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(v.name) && Number.isFinite(v.value));
  const lines = vars.map((v) => `${v.name} = ${formatAnswer(v.value)}`);
  const formula = clean(j.formula ?? "");
  if (formula) lines.push(formula);
  return { source: lines.join("\n"), solution: { prompt: question, steps: [...vars.map((v) => `${v.name} = ${formatAnswer(v.value)}: ${v.meaning}`), ...(j.steps ?? [])], answer: j.answer ?? "" } };
}
