/**
 * Smart math helpers: plain maths ("(a+b+c+d)/2") drawn as a proper formula without LaTeX, the
 * working shown step by step, points for a chart, nice steps for the wheels and sliders, and a
 * small library of ready formulas.
 */
import { evaluate, formatAnswer, isFunctionName, type Vars } from "./mathEval";

type Node =
  | { t: "num"; v: string }
  | { t: "name"; v: string }
  | { t: "bin"; op: "+" | "-" | "*" | "/" | "^" | "imp"; a: Node; b: Node }
  | { t: "neg"; a: Node }
  | { t: "pct"; a: Node }
  | { t: "fn"; f: string; a: Node }
  | { t: "group"; a: Node };

const GREEK = ["alpha", "beta", "gamma", "delta", "epsilon", "theta", "lambda", "mu", "nu", "rho", "sigma", "tau", "phi", "omega", "eta", "kappa", "Delta", "Omega", "Sigma", "Theta", "Phi"];
const FN_LATEX: Record<string, string> = { sin: "\\sin", cos: "\\cos", tan: "\\tan", ln: "\\ln", log: "\\log", exp: "\\exp" };

/** Is this LaTeX already (a backslash command or braces), rather than plain maths? */
export const looksLikeLatex = (s: string) => /\\[A-Za-z]|[{}]/.test(s);

function lex(src: string): string[] | null {
  const out: string[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const m = /^(?:\d+(?:\.\d+)?|\.\d+)|^[A-Za-z_][A-Za-z0-9_]*|^π|^√/.exec(src.slice(i));
    if (m) {
      out.push(m[0]);
      i += m[0].length;
      continue;
    }
    const op = c === "−" ? "-" : c === "×" ? "*" : c === "÷" ? "/" : c;
    if (!"+-*/^()%".includes(op)) return null;
    out.push(op);
    i++;
  }
  return out;
}

function parse(tokens: string[]): Node | null {
  let p = 0;
  const peek = () => tokens[p];
  const isAtomStart = (t: string | undefined) => !!t && (t === "(" || t === "√" || /^[\d.A-Za-z_π]/.test(t));
  const expr = (): Node => {
    let a = term();
    while (peek() === "+" || peek() === "-") {
      const op = tokens[p++] as "+" | "-";
      a = { t: "bin", op, a, b: term() };
    }
    return a;
  };
  const term = (): Node => {
    let a = unary();
    for (;;) {
      if (peek() === "*" || peek() === "/") {
        const op = tokens[p++] as "*" | "/";
        a = { t: "bin", op, a, b: unary() };
      } else if (isAtomStart(peek())) a = { t: "bin", op: "imp", a, b: power() };
      else return a;
    }
  };
  const unary = (): Node => {
    if (peek() === "-") {
      p++;
      return { t: "neg", a: unary() };
    }
    if (peek() === "+") {
      p++;
      return unary();
    }
    return power();
  };
  const power = (): Node => {
    const base = postfix();
    if (peek() === "^") {
      p++;
      return { t: "bin", op: "^", a: base, b: unary() };
    }
    return base;
  };
  const postfix = (): Node => {
    let a = atom();
    while (peek() === "%") {
      p++;
      a = { t: "pct", a };
    }
    return a;
  };
  const atom = (): Node => {
    const tok = tokens[p++];
    if (tok === undefined) throw new Error("end");
    if (tok === "(") {
      const a = expr();
      if (tokens[p++] !== ")") throw new Error("bracket");
      return { t: "group", a };
    }
    if (tok === "√") return { t: "fn", f: "sqrt", a: power() };
    if (/^[\d.]/.test(tok)) return { t: "num", v: tok };
    if (tok === "π") return { t: "name", v: "pi" };
    if (/^[A-Za-z_]/.test(tok)) {
      if (isFunctionName(tok) && tok !== "pi" && tok !== "π" && peek() === "(") return { t: "fn", f: tok, a: atom() };
      return { t: "name", v: tok };
    }
    throw new Error("token");
  };
  try {
    const n = expr();
    return p === tokens.length ? n : null;
  } catch {
    return null;
  }
}

const unwrap = (n: Node): Node => (n.t === "group" ? unwrap(n.a) : n);

function nameTex(v: string): string {
  if (v === "pi") return "\\pi";
  const [base, ...sub] = v.split("_");
  const b = GREEK.includes(base) ? `\\${base}` : base.length > 1 ? `\\mathrm{${base}}` : base;
  return sub.length ? `${b}_{${sub.join("_")}}` : b;
}

function tex(n: Node): string {
  switch (n.t) {
    case "num":
      return n.v;
    case "name":
      return nameTex(n.v);
    case "group":
      return `\\left(${tex(n.a)}\\right)`;
    case "neg":
      return `-${tex(n.a)}`;
    case "pct":
      return `${tex(n.a)}\\%`;
    case "fn": {
      const inner = tex(unwrap(n.a));
      if (n.f === "sqrt") return `\\sqrt{${inner}}`;
      if (n.f === "abs") return `\\left|${inner}\\right|`;
      return `${FN_LATEX[n.f] ?? `\\operatorname{${n.f}}`}\\left(${inner}\\right)`;
    }
    case "bin": {
      if (n.op === "/") return `\\frac{${tex(unwrap(n.a))}}{${tex(unwrap(n.b))}}`;
      if (n.op === "^") {
        const base = n.a.t === "num" || n.a.t === "name" || n.a.t === "group" || n.a.t === "fn" ? tex(n.a) : `\\left(${tex(n.a)}\\right)`;
        return `${base}^{${tex(unwrap(n.b))}}`;
      }
      if (n.op === "imp") return `${tex(n.a)}${n.b.t === "num" ? " \\cdot " : n.a.t === "name" && n.b.t === "name" ? "\\," : ""}${tex(n.b)}`;
      if (n.op === "*") {
        // 2x stays 2x; numbers side by side get a dot.
        const plain = n.a.t === "num" && (n.b.t === "name" || n.b.t === "group" || n.b.t === "fn");
        return `${tex(n.a)}${plain ? "" : " \\cdot "}${tex(n.b)}`;
      }
      return `${tex(n.a)} ${n.op} ${tex(n.b)}`;
    }
  }
}

/**
 * Plain maths as LaTeX: "(a+b+c+d)/2" → "\frac{a+b+c+d}{2}", "x^2 + sqrt(y)" → "x^{2} + \sqrt{y}",
 * "v = u + a*t" → "v = u + a \cdot t". Null when it isn't maths it can read.
 */
export function plainToLatex(src: string): string | null {
  const sides = src.split("=");
  const out: string[] = [];
  for (const side of sides) {
    if (!side.trim()) {
      // "2+2=" (an empty right side) is fine; an empty left side isn't.
      if (out.length && side === sides[sides.length - 1]) continue;
      return null;
    }
    const tokens = lex(side);
    const node = tokens && parse(tokens);
    if (!node) return null;
    out.push(tex(node));
  }
  return out.join(" = ");
}

/** The LaTeX to draw for what's in a math block: LaTeX as is, plain maths converted. */
export function displayLatex(src: string): string {
  if (looksLikeLatex(src)) return src;
  return src
    .split("\n")
    .map((l) => (l.trim() ? plainToLatex(l) ?? `\\text{${l.replace(/[\\{}$&#^_%~]/g, "")}}` : ""))
    .filter(Boolean)
    .join(" \\\\ ");
}

/**
 * Plain maths in running text worth drawing as a formula: it has a fraction with a bracket, a
 * power or a root ("(a+b+c+d)/2", "x^2+1", "sqrt(b^2-4ac)"), single-letter names only, and isn't
 * a date or a URL. Each hit: where it starts and ends in `text`, and its LaTeX.
 */
export function inlineFormulas(text: string): { from: number; to: number; latex: string }[] {
  const out: { from: number; to: number; latex: string }[] = [];
  const RUN = /[A-Za-z0-9_.()π√^+\-−*/×÷]+(?:\s*[=+\-−*/×÷^]\s*[A-Za-z0-9_.()π√^+\-−*/×÷]+)*/g;
  for (const m of text.matchAll(RUN)) {
    let s = m[0];
    let from = m.index;
    // Trim punctuation and unmatched brackets at the ends ("(see (a+b)/2)." → "(a+b)/2").
    while (s && /^[.\-+*/=^]/.test(s)) (s = s.slice(1)), from++;
    while (s && /[.\-+*/=^]$/.test(s)) s = s.slice(0, -1);
    const balance = (x: string) => [...x].reduce((b, c) => b + (c === "(" ? 1 : c === ")" ? -1 : 0), 0);
    while (s.startsWith("(") && balance(s) > 0) (s = s.slice(1)), from++;
    while (s.endsWith(")") && balance(s) < 0) s = s.slice(0, -1);
    if (s.length < 3) continue;
    const before = text[from - 1];
    const after = text[from + s.length];
    if ((before && /[\p{L}\p{N}_:/@]/u.test(before)) || (after && /[\p{L}\p{N}_:/@]/u.test(after))) continue;
    const interesting = /\^|sqrt\(|√/.test(s) || (/\//.test(s) && /\(/.test(s));
    if (!interesting) continue;
    const names = s.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
    if (names.some((w) => !(w.length === 1 || /^[A-Za-z]_\w+$/.test(w) || isFunctionName(w)))) continue;
    const latex = plainToLatex(s);
    if (!latex) continue;
    out.push({ from, to: from + s.length, latex });
  }
  return out;
}

/** The expression with every known variable replaced by its value ("m*g" → "(5)*(9.8)"). */
export function substitute(expr: string, vars: Vars): string {
  return expr.replace(/[A-Za-z_][A-Za-z0-9_]*/g, (w) => (vars.has(w) && !isFunctionName(w) ? `(${formatAnswer(vars.get(w)!)})` : w));
}

/** Step-by-step working for "name = expr" or "expr": the formula, the values put in, the answer. */
export function workingFor(src: string, vars: Vars): { steps: string[]; answer: string } | null {
  const parts = src.split("=").map((p) => p.trim());
  const named = parts.length >= 2 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(parts[0]);
  const expr = named ? parts[1] : parts[0];
  if (!expr) return null;
  const v = evaluate(expr, vars);
  if (v === null) return null;
  const lhs = named ? `${parts[0]} = ` : "";
  const steps = [`${lhs}${expr}`];
  const used = [...new Set(expr.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [])].filter((w) => vars.has(w) && !isFunctionName(w));
  if (used.length) {
    steps.push(used.map((w) => `${w} = ${formatAnswer(vars.get(w)!)}`).join(", "));
    steps.push(`${lhs}${substitute(expr, vars)}`);
  }
  const answer = `${lhs}${formatAnswer(v)}`;
  steps.push(answer);
  return { steps, answer };
}

/** A tidy step for a wheel or slider: about a tenth of the value's size, at least its own last decimal place. */
export function niceStep(v: number): number {
  const decimals = (formatAnswer(v).split(".")[1] ?? "").length;
  const fromDecimals = Math.pow(10, -Math.min(decimals, 4));
  if (v === 0) return 0.1;
  return Math.max(Math.pow(10, Math.floor(Math.log10(Math.abs(v))) - 1), fromDecimals);
}

/** A slider's range around a value: 0 to twice it (or its mirror for negatives), never empty. */
export function niceRange(v: number): [number, number] {
  if (v > 0) return [0, Math.max(v * 2, niceStep(v) * 10)];
  if (v < 0) return [Math.min(v * 2, -niceStep(v) * 10), 0];
  return [-10, 10];
}

/** Points of `expr` as `name` runs from..to (others from `vars`), skipping where it isn't defined. */
export function sample(expr: string, vars: Vars, name: string, from: number, to: number, n = 60): [number, number][] {
  const out: [number, number][] = [];
  const v = new Map(vars);
  for (let i = 0; i <= n; i++) {
    const x = from + ((to - from) * i) / n;
    v.set(name, x);
    const y = evaluate(expr, v) ?? evaluate(`0+${expr}`, v);
    if (y !== null && Number.isFinite(y)) out.push([x, y]);
  }
  return out;
}

export interface Formula {
  name: string;
  /** Plain maths, as it's written into the block. */
  plain: string;
  /** What each letter means. */
  vars: string;
  group: string;
}

/** Ready formulas for the "📚 Formulas" library. */
export const FORMULAS: Formula[] = [
  { group: "Geometry", name: "Area of a circle", plain: "A = pi*r^2", vars: "r radius" },
  { group: "Geometry", name: "Circumference", plain: "C = 2*pi*r", vars: "r radius" },
  { group: "Geometry", name: "Pythagoras", plain: "c = sqrt(a^2 + b^2)", vars: "a, b the short sides" },
  { group: "Geometry", name: "Triangle area (Heron)", plain: "A = sqrt(s*(s-a)*(s-b)*(s-c))", vars: "a, b, c sides; s = (a+b+c)/2" },
  { group: "Geometry", name: "Sphere volume", plain: "V = 4/3*pi*r^3", vars: "r radius" },
  { group: "Geometry", name: "Cylinder volume", plain: "V = pi*r^2*h", vars: "r radius, h height" },
  { group: "Algebra", name: "Quadratic root (+)", plain: "x = (-b + sqrt(b^2 - 4*a*c))/(2*a)", vars: "ax² + bx + c = 0" },
  { group: "Algebra", name: "Quadratic root (−)", plain: "x = (-b - sqrt(b^2 - 4*a*c))/(2*a)", vars: "ax² + bx + c = 0" },
  { group: "Algebra", name: "Average of four", plain: "m = (a+b+c+d)/4", vars: "a, b, c, d" },
  { group: "Algebra", name: "Percentage change", plain: "p = (n - o)/o*100", vars: "o old, n new" },
  { group: "Physics", name: "Velocity", plain: "v = u + a*t", vars: "u start speed, a acceleration, t time" },
  { group: "Physics", name: "Distance", plain: "s = u*t + 1/2*a*t^2", vars: "u start speed, a acceleration, t time" },
  { group: "Physics", name: "Force", plain: "F = m*a", vars: "m mass, a acceleration" },
  { group: "Physics", name: "Friction", plain: "f = mu*N", vars: "mu coefficient, N normal force" },
  { group: "Physics", name: "Weight", plain: "W = m*g", vars: "m mass, g = 9.81" },
  { group: "Physics", name: "Kinetic energy", plain: "E = 1/2*m*v^2", vars: "m mass, v speed" },
  { group: "Physics", name: "Potential energy", plain: "E = m*g*h", vars: "m mass, g = 9.81, h height" },
  { group: "Physics", name: "Ohm's law", plain: "V = I*R", vars: "I current, R resistance" },
  { group: "Physics", name: "Power", plain: "P = V*I", vars: "V voltage, I current" },
  { group: "Physics", name: "Pressure", plain: "p = F/A", vars: "F force, A area" },
  { group: "Money", name: "Simple interest", plain: "I = P*r*t/100", vars: "P principal, r % a year, t years" },
  { group: "Money", name: "Compound amount", plain: "A = P*(1 + r/100)^t", vars: "P principal, r % a year, t years" },
  { group: "Money", name: "Loan EMI (monthly)", plain: "E = P*(r/1200)*(1 + r/1200)^n/((1 + r/1200)^n - 1)", vars: "P loan, r % a year, n months" },
  { group: "Money", name: "Savings needed a month", plain: "s = T/n", vars: "T target, n months" },
  { group: "Health", name: "BMI", plain: "B = w/h^2", vars: "w kg, h metres" },
  { group: "Health", name: "Speed", plain: "v = d/t", vars: "d distance, t time" },
];
