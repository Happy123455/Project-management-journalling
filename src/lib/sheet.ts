// Spreadsheet tables in notes: the data kept in the note (a "sheet" block), A1 references, a small
// formula language (=SUM(A1:B5), =IF(A1>3,"big","small"), + - * / ^ &, comparisons) and Excel-like
// fill (series, "Item 1" → "Item 2", formulas with their references shifted). Pure: no editor here.

export interface SheetData {
  v: 1;
  rows: number;
  cols: number;
  /** "A1" → what was typed ("12", "Apples", "=SUM(A1:A3)"). Empty cells are left out. */
  cells: Record<string, string>;
  /** Column widths in px (optional). */
  widths?: number[];
}

export const MAX_ROWS = 500;
export const MAX_COLS = 52;

export const emptySheet = (rows = 4, cols = 4): SheetData => ({ v: 1, rows, cols, cells: {} });

export function parseSheet(raw: unknown): SheetData {
  try {
    const d = typeof raw === "string" ? JSON.parse(raw || "{}") : raw;
    if (!d || typeof d !== "object") return emptySheet();
    const o = d as Partial<SheetData>;
    const cells: Record<string, string> = {};
    for (const [k, v] of Object.entries(o.cells ?? {})) if (parseRef(k) && v != null && String(v) !== "") cells[k.toUpperCase()] = String(v);
    const rows = clampInt(o.rows, 1, MAX_ROWS, 4);
    const cols = clampInt(o.cols, 1, MAX_COLS, 4);
    return { v: 1, rows, cols, cells, ...(Array.isArray(o.widths) ? { widths: o.widths.slice(0, cols).map((w) => clampInt(w, 40, 600, 96)) } : {}) };
  } catch {
    return emptySheet();
  }
}

const clampInt = (v: unknown, lo: number, hi: number, dflt: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

// ───── References ─────

export function colName(c: number): string {
  let s = "";
  for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}
export function colIndex(name: string): number {
  let n = 0;
  for (const ch of name.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}
export const refName = (r: number, c: number) => `${colName(c)}${r + 1}`;

export function parseRef(ref: string): { r: number; c: number } | null {
  const m = /^\$?([A-Za-z]{1,2})\$?(\d{1,4})$/.exec(ref.trim());
  if (!m) return null;
  return { r: Number(m[2]) - 1, c: colIndex(m[1]) };
}

export interface Range {
  r0: number;
  c0: number;
  r1: number;
  c1: number;
}
export const normRange = (a: { r: number; c: number }, b: { r: number; c: number }): Range => ({ r0: Math.min(a.r, b.r), c0: Math.min(a.c, b.c), r1: Math.max(a.r, b.r), c1: Math.max(a.c, b.c) });

// ───── Values ─────

export type Value = number | string | boolean | SheetError;
export class SheetError {
  constructor(public code: "#REF!" | "#DIV/0!" | "#VALUE!" | "#NAME?" | "#CYCLE!" | "#ERROR!" | "#N/A") {}
  toString() {
    return this.code;
  }
}
const isErr = (v: unknown): v is SheetError => v instanceof SheetError;

const num = (v: Value): number | SheetError => {
  if (isErr(v)) return v;
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v === "") return 0;
  const n = Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : new SheetError("#VALUE!");
};
const text = (v: Value): string => (typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : typeof v === "number" ? fmtNum(v) : String(v));
const truthy = (v: Value): boolean | SheetError => (isErr(v) ? v : typeof v === "string" ? v !== "" && v.toUpperCase() !== "FALSE" && v !== "0" : !!v);

export function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return "#NUM!";
  if (Number.isInteger(n)) return String(n);
  const r = Math.round(n * 1e10) / 1e10;
  return String(r);
}

/** What a typed value means outside formulas: numbers (also "1,200" and "12%"), TRUE/FALSE, or text. */
export function literal(raw: string): Value {
  const s = raw.trim();
  if (s === "") return "";
  if (/^[-+]?(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$/.test(s) || /^[-+]?\.\d+$/.test(s)) return Number(s.replace(/,/g, ""));
  if (/^[-+]?\d+(\.\d+)?%$/.test(s)) return Number(s.slice(0, -1)) / 100;
  if (/^(true|false)$/i.test(s)) return s.toUpperCase() === "TRUE";
  return raw;
}

// ───── Formulas ─────

type Tok = { t: "num"; v: number } | { t: "str"; v: string } | { t: "ref"; v: string } | { t: "name"; v: string } | { t: "op"; v: string };

function tokenize(src: string): Tok[] | SheetError {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '"') {
      let s = "";
      i++;
      while (i < src.length) {
        if (src[i] === '"' && src[i + 1] === '"') {
          s += '"';
          i += 2;
        } else if (src[i] === '"') break;
        else s += src[i++];
      }
      if (src[i] !== '"') return new SheetError("#ERROR!");
      i++;
      out.push({ t: "str", v: s });
      continue;
    }
    const n = /^(\d+(\.\d+)?|\.\d+)([eE][-+]?\d+)?/.exec(src.slice(i));
    if (n) {
      out.push({ t: "num", v: Number(n[0]) });
      i += n[0].length;
      continue;
    }
    const w = /^\$?[A-Za-z_][A-Za-z0-9_.]*\$?\d*/.exec(src.slice(i));
    if (w) {
      const word = w[0];
      if (/^\$?[A-Za-z]{1,2}\$?\d{1,4}$/.test(word) && src[i + word.length] !== "(") out.push({ t: "ref", v: word.toUpperCase() });
      else out.push({ t: "name", v: word.toUpperCase() });
      i += word.length;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === "<=" || two === ">=" || two === "<>") {
      out.push({ t: "op", v: two });
      i += 2;
      continue;
    }
    if ("+-*/^&=<>(),:;%".includes(ch)) {
      out.push({ t: "op", v: ch === ";" ? "," : ch });
      i++;
      continue;
    }
    return new SheetError("#ERROR!");
  }
  return out;
}

type Node =
  | { k: "lit"; v: Value }
  | { k: "ref"; ref: string }
  | { k: "range"; a: string; b: string }
  | { k: "un"; op: string; x: Node }
  | { k: "bin"; op: string; a: Node; b: Node }
  | { k: "pct"; x: Node }
  | { k: "call"; name: string; args: Node[] };

function parseFormula(src: string): Node | SheetError {
  const toks = tokenize(src);
  if (isErr(toks)) return toks;
  let p = 0;
  const peek = () => toks[p];
  const isOp = (v: string) => peek()?.t === "op" && peek().v === v;
  const fail = () => {
    throw new SheetError("#ERROR!");
  };
  const expect = (v: string) => (isOp(v) ? p++ : fail());
  const cmp = (): Node => {
    let a = concat();
    while (peek()?.t === "op" && ["=", "<>", "<", ">", "<=", ">="].includes(String(peek().v))) {
      const op = (toks[p++] as { v: string }).v;
      a = { k: "bin", op, a, b: concat() };
    }
    return a;
  };
  const concat = (): Node => {
    let a = add();
    while (isOp("&")) {
      p++;
      a = { k: "bin", op: "&", a, b: add() };
    }
    return a;
  };
  const add = (): Node => {
    let a = mul();
    while (isOp("+") || isOp("-")) {
      const op = (toks[p++] as { v: string }).v;
      a = { k: "bin", op, a, b: mul() };
    }
    return a;
  };
  const mul = (): Node => {
    let a = pow();
    while (isOp("*") || isOp("/")) {
      const op = (toks[p++] as { v: string }).v;
      a = { k: "bin", op, a, b: pow() };
    }
    return a;
  };
  const pow = (): Node => {
    const a = unary();
    if (isOp("^")) {
      p++;
      return { k: "bin", op: "^", a, b: pow() };
    }
    return a;
  };
  const unary = (): Node => {
    if (isOp("-") || isOp("+")) {
      const op = (toks[p++] as { v: string }).v;
      return { k: "un", op, x: unary() };
    }
    let x = primary();
    while (isOp("%")) {
      p++;
      x = { k: "pct", x };
    }
    return x;
  };
  const primary = (): Node => {
    const t = toks[p++];
    if (!t) fail();
    if (t.t === "num") return { k: "lit", v: t.v };
    if (t.t === "str") return { k: "lit", v: t.v };
    if (t.t === "ref") {
      if (isOp(":")) {
        p++;
        const b = toks[p++];
        if (b?.t !== "ref") fail();
        return { k: "range", a: t.v, b: (b as { v: string }).v };
      }
      return { k: "ref", ref: t.v };
    }
    if (t.t === "name") {
      if (t.v === "TRUE" || t.v === "FALSE") {
        if (isOp("(")) {
          p++;
          expect(")");
        }
        return { k: "lit", v: t.v === "TRUE" };
      }
      if (!isOp("(")) throw new SheetError("#NAME?");
      p++;
      const args: Node[] = [];
      if (!isOp(")")) {
        args.push(cmp());
        while (isOp(",")) {
          p++;
          args.push(cmp());
        }
      }
      expect(")");
      return { k: "call", name: t.v, args };
    }
    if (t.t === "op" && t.v === "(") {
      const x = cmp();
      expect(")");
      return x;
    }
    return fail();
  };
  try {
    const n = cmp();
    if (p < toks.length) fail();
    return n;
  } catch (e) {
    return isErr(e) ? e : new SheetError("#ERROR!");
  }
}

type Arg = Value | Value[];
const flat = (args: Arg[]): Value[] => args.flatMap((a) => (Array.isArray(a) ? a : [a]));
/** Numbers among the values (ranges skip text and blanks, like a spreadsheet). */
function nums(args: Arg[]): number[] | SheetError {
  const out: number[] = [];
  for (const a of args) {
    if (Array.isArray(a)) {
      for (const v of a) {
        if (isErr(v)) return v;
        if (typeof v === "number") out.push(v);
      }
    } else {
      const n = num(a);
      if (isErr(n)) return n;
      out.push(n);
    }
  }
  return out;
}

/** "> 5", "<=3", "apple", 4 → a test for SUMIF/COUNTIF. */
function criterion(c: Value): (v: Value) => boolean {
  const s = text(c);
  const m = /^(<=|>=|<>|<|>|=)?(.*)$/.exec(s)!;
  const op = m[1] ?? "=";
  const rhs = literal(m[2]);
  return (v) => {
    if (isErr(v)) return false;
    const a = typeof rhs === "number" ? num(v) : text(v).toLowerCase();
    const b = typeof rhs === "number" ? rhs : text(rhs).toLowerCase();
    if (isErr(a)) return false;
    switch (op) {
      case "<": return a < b;
      case ">": return a > b;
      case "<=": return a <= b;
      case ">=": return a >= b;
      case "<>": return a !== b;
      default: return a === b;
    }
  };
}

export const FUNCTIONS = ["SUM", "AVERAGE", "MIN", "MAX", "COUNT", "COUNTA", "IF", "AND", "OR", "NOT", "ROUND", "ABS", "SQRT", "PRODUCT", "MEDIAN", "IFERROR", "CONCAT", "LEN", "UPPER", "LOWER", "SUMIF", "COUNTIF", "POWER", "MOD", "INT"];

/** Every cell's value. Cycles and bad formulas become errors in those cells only. */
export function evaluate(data: SheetData): Map<string, Value> {
  const done = new Map<string, Value>();
  const busy = new Set<string>();
  const cache = new Map<string, Node | SheetError>();

  const cellValue = (ref: string): Value => {
    const key = ref.replace(/\$/g, "");
    const at = parseRef(key);
    if (!at || at.r >= MAX_ROWS || at.c >= MAX_COLS) return new SheetError("#REF!");
    if (done.has(key)) return done.get(key)!;
    if (busy.has(key)) return new SheetError("#CYCLE!");
    const raw = data.cells[key] ?? "";
    let v: Value;
    if (!raw.startsWith("=")) v = literal(raw);
    else {
      busy.add(key);
      let ast = cache.get(raw);
      if (!ast) cache.set(raw, (ast = parseFormula(raw.slice(1))));
      v = isErr(ast) ? ast : run(ast);
      if (Array.isArray(v)) v = new SheetError("#VALUE!");
      busy.delete(key);
    }
    done.set(key, v);
    return v;
  };

  const rangeValues = (a: string, b: string): Value[] | SheetError => {
    const p = parseRef(a.replace(/\$/g, ""));
    const q = parseRef(b.replace(/\$/g, ""));
    if (!p || !q) return new SheetError("#REF!");
    const g = normRange(p, q);
    if ((g.r1 - g.r0 + 1) * (g.c1 - g.c0 + 1) > 20000) return new SheetError("#REF!");
    const out: Value[] = [];
    for (let r = g.r0; r <= g.r1; r++) for (let c = g.c0; c <= g.c1; c++) out.push(cellValue(refName(r, c)));
    return out;
  };

  const arg = (n: Node): Arg => {
    if (n.k === "range") {
      const v = rangeValues(n.a, n.b);
      return isErr(v) ? v : v;
    }
    return run(n);
  };

  const call = (name: string, raw: Node[]): Value => {
    // IF and IFERROR only work out the branch they need.
    if (name === "IF") {
      if (raw.length < 2 || raw.length > 3) return new SheetError("#VALUE!");
      const c = truthy(run(raw[0]));
      if (isErr(c)) return c;
      return c ? run(raw[1]) : raw[2] ? run(raw[2]) : false;
    }
    if (name === "IFERROR") {
      if (raw.length !== 2) return new SheetError("#VALUE!");
      const v = run(raw[0]);
      return isErr(v) ? run(raw[1]) : v;
    }
    const args = raw.map(arg);
    for (const a of args) if (isErr(a)) return a;
    const ns = () => nums(args);
    switch (name) {
      case "SUM": {
        const n = ns();
        return isErr(n) ? n : n.reduce((s, x) => s + x, 0);
      }
      case "AVERAGE": {
        const n = ns();
        return isErr(n) ? n : n.length ? n.reduce((s, x) => s + x, 0) / n.length : new SheetError("#DIV/0!");
      }
      case "MIN": {
        const n = ns();
        return isErr(n) ? n : n.length ? Math.min(...n) : 0;
      }
      case "MAX": {
        const n = ns();
        return isErr(n) ? n : n.length ? Math.max(...n) : 0;
      }
      case "PRODUCT": {
        const n = ns();
        return isErr(n) ? n : n.reduce((s, x) => s * x, 1);
      }
      case "MEDIAN": {
        const n = ns();
        if (isErr(n)) return n;
        if (!n.length) return new SheetError("#N/A");
        const s = [...n].sort((a, b) => a - b);
        return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
      }
      case "COUNT":
        return flat(args).filter((v) => typeof v === "number").length;
      case "COUNTA":
        return flat(args).filter((v) => v !== "").length;
      case "AND":
      case "OR": {
        const vs = flat(args).filter((v) => v !== "").map(truthy);
        const e = vs.find(isErr);
        if (e) return e;
        return name === "AND" ? vs.every(Boolean) : vs.some(Boolean);
      }
      case "NOT": {
        const t = truthy(args[0] as Value);
        return isErr(t) ? t : !t;
      }
      case "ROUND": {
        const x = num(args[0] as Value);
        const d = args[1] === undefined ? 0 : num(args[1] as Value);
        if (isErr(x)) return x;
        if (isErr(d)) return d;
        const f = 10 ** d;
        return Math.round(x * f + Math.sign(x) * 1e-9) / f;
      }
      case "INT": {
        const x = num(args[0] as Value);
        return isErr(x) ? x : Math.floor(x);
      }
      case "ABS":
      case "SQRT": {
        const x = num(args[0] as Value);
        if (isErr(x)) return x;
        if (name === "SQRT" && x < 0) return new SheetError("#VALUE!");
        return name === "ABS" ? Math.abs(x) : Math.sqrt(x);
      }
      case "POWER":
      case "MOD": {
        const a = num(args[0] as Value);
        const b = num(args[1] as Value);
        if (isErr(a)) return a;
        if (isErr(b)) return b;
        if (name === "MOD") return b === 0 ? new SheetError("#DIV/0!") : a - b * Math.floor(a / b);
        return a ** b;
      }
      case "CONCAT":
        return flat(args).map(text).join("");
      case "LEN":
        return text(args[0] as Value).length;
      case "UPPER":
        return text(args[0] as Value).toUpperCase();
      case "LOWER":
        return text(args[0] as Value).toLowerCase();
      case "SUMIF":
      case "COUNTIF": {
        const range = Array.isArray(args[0]) ? args[0] : [args[0] as Value];
        const test = criterion(args[1] as Value);
        if (name === "COUNTIF") return range.filter(test).length;
        const sumRange = args[2] === undefined ? range : Array.isArray(args[2]) ? args[2] : [args[2] as Value];
        let s = 0;
        range.forEach((v, i) => {
          if (!test(v)) return;
          const n = num(sumRange[i] ?? 0);
          if (!isErr(n)) s += n;
        });
        return s;
      }
      default:
        return new SheetError("#NAME?");
    }
  };

  function run(n: Node): Value {
    switch (n.k) {
      case "lit":
        return n.v;
      case "ref": {
        const v = cellValue(n.ref);
        return v;
      }
      case "range":
        return new SheetError("#VALUE!");
      case "pct": {
        const x = num(run(n.x));
        return isErr(x) ? x : x / 100;
      }
      case "un": {
        const x = num(run(n.x));
        return isErr(x) ? x : n.op === "-" ? -x : x;
      }
      case "call":
        return call(n.name, n.args);
      case "bin": {
        const a = run(n.a);
        const b = run(n.b);
        if (isErr(a)) return a;
        if (isErr(b)) return b;
        if (n.op === "&") return text(a) + text(b);
        if (["=", "<>", "<", ">", "<=", ">="].includes(n.op)) {
          const both = typeof a === "number" && typeof b === "number";
          const x = both ? a : text(a).toLowerCase();
          const y = both ? b : text(b).toLowerCase();
          switch (n.op) {
            case "=": return x === y;
            case "<>": return x !== y;
            case "<": return x < y;
            case ">": return x > y;
            case "<=": return x <= y;
            default: return x >= y;
          }
        }
        const x = num(a);
        const y = num(b);
        if (isErr(x)) return x;
        if (isErr(y)) return y;
        switch (n.op) {
          case "+": return x + y;
          case "-": return x - y;
          case "*": return x * y;
          case "/": return y === 0 ? new SheetError("#DIV/0!") : x / y;
          default: return x ** y;
        }
      }
    }
  }

  for (let r = 0; r < data.rows; r++) for (let c = 0; c < data.cols; c++) cellValue(refName(r, c));
  return done;
}

/** A value as shown in its cell. */
export const display = (v: Value | undefined): string => (v === undefined ? "" : isErr(v) ? v.code : text(v));
export const isError = isErr;

// ───── Fill (dragging the corner) ─────

/** The formula with its relative references moved by (dr, dc); `$` parts stay. Off-sheet refs become #REF!. */
export function shiftFormula(formula: string, dr: number, dc: number): string {
  if (!formula.startsWith("=")) return formula;
  // Leave text in quotes alone.
  return formula.replace(/("(?:[^"]|"")*")|(\$?)([A-Za-z]{1,2})(\$?)(\d{1,4})(?![A-Za-z0-9_(])/g, (all, str, dCol, col, dRow, row, offset: number, whole: string) => {
    if (str) return str;
    // A name like LOG10 or a function: not a reference.
    const before = whole[offset - 1];
    if (before && /[A-Za-z0-9_]/.test(before)) return all;
    const c = dCol ? colIndex(col) : colIndex(col) + dc;
    const r = dRow ? Number(row) - 1 : Number(row) - 1 + dr;
    if (c < 0 || r < 0 || c >= MAX_COLS || r >= MAX_ROWS) return "#REF!";
    return `${dCol}${colName(c)}${dRow}${r + 1}`;
  });
}

/**
 * Fills `target` from the `source` block (the selection before dragging), along the direction
 * the target grows: numbers that step evenly keep stepping, "Item 3" counts on, formulas shift
 * their references, anything else repeats.
 */
export function fill(data: SheetData, source: Range, target: Range): SheetData {
  const cells = { ...data.cells };
  const down = target.r1 > source.r1 || target.r0 < source.r0;
  const h = source.r1 - source.r0 + 1;
  const w = source.c1 - source.c0 + 1;
  const lines = down ? w : h;
  for (let line = 0; line < lines; line++) {
    // The source values along this column (down) or row (across).
    const seq: { raw: string; r: number; c: number }[] = [];
    const len = down ? h : w;
    for (let i = 0; i < len; i++) {
      const r = down ? source.r0 + i : source.r0 + line;
      const c = down ? source.c0 + line : source.c0 + i;
      seq.push({ raw: data.cells[refName(r, c)] ?? "", r, c });
    }
    const vals = seq.map((s) => (s.raw.startsWith("=") ? null : literal(s.raw)));
    const allNums = vals.every((v) => typeof v === "number");
    const step = allNums && seq.length >= 2 ? (vals[seq.length - 1] as number) - (vals[seq.length - 2] as number) : null;
    const evenly = step != null && vals.every((v, i) => i === 0 || Math.abs((v as number) - (vals[i - 1] as number) - step) < 1e-9);
    const counted = seq.length === 1 ? /^(.*?)(\d+)$/.exec(seq[0].raw) : null;
    const span = down ? [target.r0, target.r1] : [target.c0, target.c1];
    for (let pos = span[0]; pos <= span[1]; pos++) {
      const inSource = down ? pos >= source.r0 && pos <= source.r1 : pos >= source.c0 && pos <= source.c1;
      if (inSource) continue;
      const r = down ? pos : source.r0 + line;
      const c = down ? source.c0 + line : pos;
      // Offset from the source's start (negative when dragging up or left).
      const off = down ? pos - source.r0 : pos - source.c0;
      const k = ((off % len) + len) % len;
      const src = seq[k];
      let out: string;
      if (src.raw.startsWith("=")) out = shiftFormula(src.raw, r - src.r, c - src.c);
      else if (evenly && step != null) out = fmtNum((vals[0] as number) + step * off);
      else if (counted && !allNums && counted[1].trim() !== "") out = `${counted[1]}${Number(counted[2]) + off}`;
      else out = src.raw;
      const key = refName(r, c);
      if (out === "") delete cells[key];
      else cells[key] = out;
    }
  }
  return { ...data, cells, rows: Math.max(data.rows, target.r1 + 1), cols: Math.max(data.cols, target.c1 + 1) };
}

/** The sheet as tab-separated rows of shown values (search, plain text, the AI). */
export function sheetText(data: SheetData, values = evaluate(data)): string {
  const lines: string[] = [];
  for (let r = 0; r < data.rows; r++) {
    const row: string[] = [];
    for (let c = 0; c < data.cols; c++) row.push(display(values.get(refName(r, c))));
    while (row.length && row[row.length - 1] === "") row.pop();
    lines.push(row.join("\t"));
  }
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}

/** For the AI: every non-empty cell with what's typed and what it shows. */
export function sheetForAi(data: SheetData): string {
  const values = evaluate(data);
  const keys = Object.keys(data.cells).sort((a, b) => {
    const p = parseRef(a)!;
    const q = parseRef(b)!;
    return p.r - q.r || p.c - q.c;
  });
  return [`${data.rows} rows × ${data.cols} columns (A–${colName(data.cols - 1)})`, ...keys.map((k) => (data.cells[k].startsWith("=") ? `${k}: ${data.cells[k]} → ${display(values.get(k))}` : `${k}: ${data.cells[k]}`))].join("\n");
}

/** Sets cells ({"A1": "12", "B2": "=SUM(A1:A3)", "C3": ""}), growing the sheet when needed. */
export function setCells(data: SheetData, patch: Record<string, unknown>): SheetData | string {
  const cells = { ...data.cells };
  let rows = data.rows;
  let cols = data.cols;
  for (const [k, v] of Object.entries(patch)) {
    const at = parseRef(k);
    if (!at || at.r >= MAX_ROWS || at.c >= MAX_COLS) return `${k} isn't a cell (use A1 style, up to ${colName(MAX_COLS - 1)}${MAX_ROWS}).`;
    const key = refName(at.r, at.c);
    const s = v == null ? "" : String(v);
    if (s === "") delete cells[key];
    else cells[key] = s;
    rows = Math.max(rows, at.r + 1);
    cols = Math.max(cols, at.c + 1);
  }
  return { ...data, cells, rows, cols };
}
