/**
 * Auto math (Settings → Editor → Solve math as you type): typing "=" after a sum like "12+12"
 * writes the answer after it ("12+12=24"). Only plain arithmetic is understood: numbers (with
 * thousands commas and decimals), + − × ÷ (also * / x), ^ for powers, % for percent, and brackets.
 */

const OPS = "+\\-−*/×÷xX^%";
/** The arithmetic right before the "=" (letters before it are left alone: "max 3+4=" → "3+4"). */
const TAIL = new RegExp(`[\\d.,\\s()${OPS}]+$`);

type Tok = { k: "n"; v: number } | { k: "op"; v: string };

function tokens(src: string): Tok[] | null {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === " ") {
      i++;
      continue;
    }
    const num = /^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|^\.\d+/.exec(src.slice(i));
    if (num) {
      out.push({ k: "n", v: Number(num[0].replace(/,/g, "")) });
      i += num[0].length;
      continue;
    }
    const op = c === "−" ? "-" : c === "×" || c === "x" || c === "X" ? "*" : c === "÷" ? "/" : c;
    if (!"+-*/^%()".includes(op)) return null;
    out.push({ k: "op", v: op });
    i++;
  }
  return out;
}

/** Value of an arithmetic expression, or null when it isn't one (or has no operator in it). */
export function evaluate(src: string): number | null {
  const t = tokens(src);
  if (!t || !t.length) return null;
  // At least one real operation between numbers: "2026" or "(5)" alone isn't a sum.
  const binary = t.some((x, j) => x.k === "op" && "+-*/^".includes(x.v) && j > 0 && (t[j - 1].k === "n" || t[j - 1].v === ")" || t[j - 1].v === "%"));
  if (!binary && !t.some((x) => x.k === "op" && x.v === "%")) return null;
  let p = 0;
  const peek = () => t[p];
  const isOp = (v: string) => peek()?.k === "op" && peek()!.v === v;
  // expr := term (("+"|"-") term)*
  const expr = (): number => {
    let v = term();
    while (isOp("+") || isOp("-")) {
      const op = (t[p++] as { v: string }).v;
      const r = term();
      v = op === "+" ? v + r : v - r;
    }
    return v;
  };
  // term := unary (("*"|"/") unary)*
  const term = (): number => {
    let v = unary();
    while (isOp("*") || isOp("/")) {
      const op = (t[p++] as { v: string }).v;
      const r = unary();
      v = op === "*" ? v * r : v / r;
    }
    return v;
  };
  // unary := ("-"|"+") unary | power   (so -2^2 = -(2^2), as in maths)
  const unary = (): number => {
    if (isOp("-")) {
      p++;
      return -unary();
    }
    if (isOp("+")) {
      p++;
      return unary();
    }
    return power();
  };
  // power := postfix ("^" unary)?   (right to left, like 2^3^2 = 2^9)
  const power = (): number => {
    const base = postfix();
    if (isOp("^")) {
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
    } else if (tok.v === "(") {
      p++;
      v = expr();
      if (!isOp(")")) throw new Error("bracket");
      p++;
    } else throw new Error("token");
    while (isOp("%")) {
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
 */
export function answerFor(before: string): string | null {
  const m = TAIL.exec(before);
  if (!m) return null;
  let expr = m[0];
  // "x" is a times sign only between numbers; trim any that start the tail ("box 2+2" → "2+2").
  expr = expr.replace(/^[\s,.xX%*/×÷^)]+/, "");
  if (!/\d/.test(expr)) return null;
  const start = before.length - expr.length;
  const prev = before[start - 1];
  if (prev && /[\p{L}\p{N}_]/u.test(prev)) return null;
  const v = evaluate(expr);
  return v === null ? null : formatAnswer(v);
}
