/**
 * Auto math (Settings → Editor → Solve math as you type): typing "=" after a sum like "12+12"
 * writes the answer after it ("12+12=24"). Only plain arithmetic is understood: numbers (with
 * thousands commas and decimals), + − × ÷ (also * / x), ^ for powers, % for percent, and brackets.
 */

const OPS = "+\\-−*/×÷xX^%";
/** The arithmetic right before the "=" (letters before it are left alone: "max 3+4=" → "3+4"). */
const TAIL = new RegExp(`[\\d.,\\s()${OPS}]+$`);
/** The same, with names and functions in it (when variables are defined). */
const TAIL_NAMES = new RegExp(`[\\w.,\\s()π${OPS}]+$`);

type Tok = { k: "n"; v: number; named?: boolean } | { k: "op"; v: string } | { k: "f"; v: (x: number) => number };

/** Variables defined in the note so far ("x = 5"), by name. */
export type Vars = Map<string, number>;

const FUNCS: Record<string, (x: number) => number> = {
  sqrt: Math.sqrt, sin: Math.sin, cos: Math.cos, tan: Math.tan, ln: Math.log, log: Math.log10, abs: Math.abs, exp: Math.exp,
};
const CONSTS: Record<string, number> = { pi: Math.PI, π: Math.PI };

function tokens(src: string, vars?: Vars): Tok[] | null {
  const out: Tok[] = [];
  let i = 0;
  const push = (t: Tok) => {
    // Written side by side means times: "2x", "3(4)", "x y", "2 sqrt(9)" (two plain numbers never).
    const prev = out[out.length - 1];
    const ends = !!prev && (prev.k === "n" || (prev.k === "op" && (prev.v === ")" || prev.v === "%")));
    const starts = t.k === "f" || (t.k === "op" && t.v === "(") || (t.k === "n" && (!!t.named || (prev?.k === "n" && !!prev.named)));
    if (ends && starts) out.push({ k: "op", v: "*" });
    out.push(t);
  };
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\u00a0") {
      i++;
      continue;
    }
    const num = /^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|^\.\d+/.exec(src.slice(i));
    if (num) {
      push({ k: "n", v: Number(num[0].replace(/,/g, "")) });
      i += num[0].length;
      continue;
    }
    const word = /^[A-Za-z_π][A-Za-z0-9_]*/.exec(src.slice(i));
    if (word) {
      const w = word[0];
      if (vars?.has(w)) push({ k: "n", v: vars.get(w)!, named: true });
      else if (w in FUNCS) push({ k: "f", v: FUNCS[w] });
      else if (w in CONSTS) push({ k: "n", v: CONSTS[w], named: true });
      // An "x" that isn't a variable is a times sign ("3x4"); any other unknown word isn't maths.
      else if (!/^[xX]/.test(w)) return null;
      if (vars?.has(w) || w in FUNCS || w in CONSTS) {
        i += w.length;
        continue;
      }
    }
    const op = c === "−" ? "-" : c === "×" || c === "x" || c === "X" ? "*" : c === "÷" ? "/" : c;
    if (!"+-*/^%()".includes(op)) return null;
    if (op === "(") push({ k: "op", v: op });
    else out.push({ k: "op", v: op });
    i++;
  }
  return out;
}

/** Value of an arithmetic expression, or null when it isn't one (or has no operator in it). */
export function evaluate(src: string, vars?: Vars): number | null {
  const t = tokens(src, vars);
  if (!t || !t.length) return null;
  // At least one real operation between numbers: "2026" or "(5)" alone isn't a sum. A variable or
  // a function is enough ("x =" shows x).
  const isOp = (x: Tok, v: string) => x.k === "op" && x.v === v;
  const binary = t.some((x, j) => x.k === "op" && "+-*/^".includes(x.v) && j > 0 && (t[j - 1].k === "n" || isOp(t[j - 1], ")") || isOp(t[j - 1], "%")));
  if (!binary && !t.some((x) => isOp(x, "%") || x.k === "f" || (x.k === "n" && x.named))) return null;
  let p = 0;
  const peek = () => t[p];
  const at = (v: string) => peek()?.k === "op" && (peek() as { v: string }).v === v;
  // expr := term (("+"|"-") term)*
  const expr = (): number => {
    let v = term();
    while (at("+") || at("-")) {
      const op = (t[p++] as { v: string }).v;
      const r = term();
      v = op === "+" ? v + r : v - r;
    }
    return v;
  };
  // term := unary (("*"|"/") unary)*
  const term = (): number => {
    let v = unary();
    while (at("*") || at("/")) {
      const op = (t[p++] as { v: string }).v;
      const r = unary();
      v = op === "*" ? v * r : v / r;
    }
    return v;
  };
  // unary := ("-"|"+") unary | power   (so -2^2 = -(2^2), as in maths)
  const unary = (): number => {
    if (at("-")) {
      p++;
      return -unary();
    }
    if (at("+")) {
      p++;
      return unary();
    }
    return power();
  };
  // power := postfix ("^" unary)?   (right to left, like 2^3^2 = 2^9)
  const power = (): number => {
    const base = postfix();
    if (at("^")) {
      p++;
      return Math.pow(base, unary());
    }
    return base;
  };
  // A number or bracket, then any "%" (percent: 50% = 0.5).
  const postfix = (): number => {
    let v: number;
    const tok = peek();
    if (!tok) throw new Error("end");
    if (tok.k === "n") {
      p++;
      v = tok.v;
    } else if (tok.k === "f") {
      p++;
      v = tok.v(power());
    } else if (tok.v === "(") {
      p++;
      v = expr();
      if (!at(")")) throw new Error("bracket");
      p++;
    } else throw new Error("token");
    while (at("%")) {
      p++;
      v /= 100;
    }
    return v;
  };
  try {
    const v = expr();
    if (p !== t.length || !Number.isFinite(v)) return null;
    return v;
  } catch {
    return null;
  }
}

/** The answer as written in a note: no float noise (0.1+0.2 → 0.3), up to 10 decimals. */
export function formatAnswer(v: number): string {
  const r = Math.round(v * 1e10) / 1e10;
  if (Object.is(r, -0)) return "0";
  if (Math.abs(r) >= 1e15) return String(r);
  return r.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 10 });
}

/**
 * Text before a just-typed "=" (not including it) → the answer to write after it, or null.
 * The sum must sit right before the "=", and must not continue a word or number ("a2+2", "v1.2").
 * With `vars` (defined earlier in the note: "x = 5"), names and functions can be in it: "2x + sqrt(x) =".
 */
export function answerFor(before: string, vars?: Vars): string | null {
  // "x =" on its own starts a definition, never shows the old value.
  if (/^\s*[A-Za-z_π][A-Za-z0-9_]*\s*$/.test(before)) return null;
  const m = (vars?.size ? TAIL_NAMES : TAIL).exec(before);
  if (!m) return null;
  const tail = m[0];
  // The longest piece that works: "max 3+4" → "3+4", "box 2+2" → "2+2".
  for (let k = 0; k < tail.length; k++) {
    if (k > 0 && !/[\s,.xX%*/×÷^)(+\-−]/.test(tail[k - 1]) && !/[\s(]/.test(tail[k - 1])) continue;
    let expr = tail.slice(k);
    // "x" is a times sign only between numbers; trim any that start the tail ("box 2+2" → "2+2").
    if (!vars?.has("x") && !vars?.has("X")) expr = expr.replace(/^[\s,.xX%*/×÷^)]+/, "");
    else expr = expr.replace(/^[\s,.%*/×÷^)]+/, "");
    if (!/[\dA-Za-zπ]/.test(expr)) continue;
    const start = before.length - expr.length;
    const prev = before[start - 1];
    if (prev && /[\p{L}\p{N}_]/u.test(prev)) continue;
    const v = evaluate(expr, vars);
    if (v !== null) return formatAnswer(v);
  }
  return null;
}

const NAME = /^\s*([A-Za-z_π][A-Za-z0-9_]*)\s*$/;
/** The name at the end of a sentence before "=": "the mass m = 5", "friction coefficient μ_k = 0.4". Short names only. */
const TRAILING_NAME = /(?:^|\s)([A-Za-z_][A-Za-z0-9_]{0,2})\s*$/;
/** "coefficient(F)=1.2": a name in brackets, then "=". */
const BRACKET_NAME = /\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)\s*=\s*/g;
/** "coefficient(F=1.2)" or "(F = 1.2 N)": a whole definition in brackets. */
const BRACKET_DEF = /\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([^()=]+?)\s*\)/g;

export const isFunctionName = (w: string) => w in FUNCS || w in CONSTS;

/** One variable definition found in the note. */
export interface Definition {
  name: string;
  value: number;
  /** Which line (0-based, in the lines given). */
  line: number;
  /** The words before it, when written in a sentence ("friction coefficient"). */
  label?: string;
}

/**
 * The value at the start of `text`: the longest run of words that works out ("1.2 N" → 1.2,
 * "x*2 = 10" → x*2), or null.
 */
function leadingValue(text: string, vars: Vars): number | null {
  const words = text.trim().split(/\s+/);
  for (let n = words.length; n > 0; n--) {
    const part = words.slice(0, n).join(" ");
    const v = evaluate(part, vars) ?? (/^-?[\d.,]+$/.test(part) && /\d/.test(part) ? Number(part.replace(/,/g, "")) : null);
    if (v !== null && Number.isFinite(v)) return v;
  }
  return null;
}

/** "this is a friction coefficient" → "friction coefficient" (the last few words, small words dropped). */
function labelOf(text: string): string | undefined {
  const words = text.replace(/[^\p{L}\p{N}\s]/gu, " ").trim().split(/\s+/).filter(Boolean);
  const SMALL = new Set(["this", "is", "a", "an", "the", "of", "my", "our", "and", "it", "its", "that", "which", "let", "be", "for", "with", "where", "so"]);
  while (words.length && SMALL.has(words[0].toLowerCase())) words.shift();
  const out = words.slice(-4).join(" ");
  return out || undefined;
}

/**
 * Every definition in the lines, in order. Understood, like Apple's Math Notes and in a sentence:
 * "x = 5", "rate = 12/60", "total = x * rate", "y = x*2 = 10" (the written answer),
 * "the mass m = 5 kg", "this is a friction coefficient(F)=1.2", "a friction coefficient(F=1.2)".
 * Each may use the ones before it.
 */
export function definitionsIn(lines: string[], start: Vars = new Map()): Definition[] {
  const vars = new Map(start);
  const out: Definition[] = [];
  const add = (name: string, value: number | null, line: number, label?: string) => {
    if (value === null || !Number.isFinite(value) || name in FUNCS || name in CONSTS) return;
    vars.set(name, value);
    out.push({ name, value, line, ...(label ? { label } : {}) });
  };
  lines.forEach((line, i) => {
    if (!line.includes("=")) return;
    const found = new Set<string>();
    // In brackets: "coefficient(F=1.2)".
    for (const m of line.matchAll(BRACKET_DEF)) {
      if (found.has(m[1])) continue;
      const v = leadingValue(m[2], vars);
      if (v === null) continue;
      add(m[1], v, i, labelOf(line.slice(0, m.index)));
      found.add(m[1]);
    }
    // A bracketed name then "=": "coefficient(F)=1.2".
    for (const m of line.matchAll(BRACKET_NAME)) {
      if (found.has(m[1])) continue;
      const v = leadingValue(line.slice(m.index + m[0].length).split("=")[0], vars);
      if (v === null) continue;
      add(m[1], v, i, labelOf(line.slice(0, m.index)));
      found.add(m[1]);
    }
    if (found.size) return;
    const parts = line.split("=");
    const whole = NAME.exec(parts[0]);
    const name = whole?.[1] ?? TRAILING_NAME.exec(parts[0])?.[1];
    if (!name) return;
    // A sentence before the name must end in a short name ("mass m"), not just any word ("total").
    if (!whole && /^[A-Za-z]{2,}$/.test(name)) return;
    // The written answer ("y = x*2 = 10") wins over the sum before it.
    const last = parts.length > 2 ? leadingValue(parts[parts.length - 1], vars) : null;
    add(name, last ?? leadingValue(parts[1], vars), i, whole ? undefined : labelOf(parts[0].trimEnd().slice(0, parts[0].trimEnd().length - name.length)));
  });
  return out;
}

/** Variables defined in the lines, by name (a later definition replaces an earlier one). */
export function variablesIn(lines: string[], vars: Vars = new Map()): Vars {
  for (const d of definitionsIn(lines, vars)) vars.set(d.name, d.value);
  return vars;
}

/** Names given different values in the lines (a likely mistake): name → its definitions. */
export function conflictsIn(defs: Definition[]): Map<string, Definition[]> {
  const by = new Map<string, Definition[]>();
  for (const d of defs) by.set(d.name, [...(by.get(d.name) ?? []), d]);
  const out = new Map<string, Definition[]>();
  for (const [name, list] of by) {
    const values = new Set(list.map((d) => formatAnswer(d.value)));
    if (values.size > 1) out.set(name, list);
  }
  return out;
}

/** The names an expression uses (not functions or constants): "2x + sqrt(m*g)" → ["x", "m", "g"]. */
export function namesIn(expr: string): string[] {
  const out: string[] = [];
  for (const m of expr.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
    const w = m[0];
    if (w in FUNCS || w in CONSTS || out.includes(w)) continue;
    out.push(w);
  }
  return out;
}
