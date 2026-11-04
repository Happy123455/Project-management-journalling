/**
 * Simple LaTeX → the plain maths the note's calculator reads ("\frac{x}{2} + \sqrt{9}" →
 * "((x)/(2)) + sqrt(9)"), so a math block can define variables ("r = 3") and show its value.
 * Anything it can't read stays as it is and then simply isn't calculated.
 */
export function latexToPlain(latex: string): string {
  let s = latex.replace(/\$\$?/g, "").replace(/\\left|\\right/g, "").replace(/\\[,;: !]/g, " ").replace(/\\(?:mathrm|text|operatorname)\{([^{}]*)\}/g, "$1");
  // Innermost braces first, so nested fractions and roots come out right.
  for (let i = 0; i < 20; i++) {
    const before = s;
    s = s
      .replace(/\\[dt]?frac\{([^{}]*)\}\{([^{}]*)\}/g, "(($1)/($2))")
      .replace(/\\sqrt\[([^\]]*)\]\{([^{}]*)\}/g, "(($2)^(1/($1)))")
      .replace(/\\sqrt\{([^{}]*)\}/g, "sqrt($1)")
      .replace(/\^\{([^{}]*)\}/g, "^($1)")
      .replace(/_\{([^{}]*)\}/g, "_$1");
    if (s === before) break;
  }
  return s
    .replace(/\\(?:cdot|times|ast)/g, "*")
    .replace(/\\div/g, "/")
    .replace(/\\pi\b/g, "pi")
    .replace(/\\(sin|cos|tan|ln|log|exp)\b/g, "$1")
    .replace(/\\%/g, "%")
    .replace(/[{}]/g, (b) => (b === "{" ? "(" : ")"))
    .replace(/\s+/g, " ")
    .trim();
}

/** An AI's LaTeX answer without $…$, code fences or notes around it. */
export function cleanLatex(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .trim()
    .replace(/^```(?:latex|tex)?\s*\n?([\s\S]*?)\n?```$/i, "$1")
    .trim()
    .replace(/^\$\$([\s\S]*)\$\$$/, "$1")
    .replace(/^\$([\s\S]*)\$$/, "$1")
    .replace(/^\\\[([\s\S]*)\\\]$/, "$1")
    .trim();
}
