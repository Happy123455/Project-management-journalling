// The ✦ assistant's tools for the 👛 pocket, math blocks and planning (17 Nov asks). Like the rest
// (assistant/tools.ts), every write is the assistant's, so it shows in AI changes with Undo.
import type { JSONContent } from "@tiptap/core";
import type { JournalStore } from "../store";
import type { ToolCall } from "../ai/agent";
import { solveMath } from "../ai/mathSolve";
import { appendBlocks } from "../lib/append";
import { formatAnswer } from "../lib/mathEval";
import { describeFormula, formulaMatches, mathBlocksIn, setValuesIn, workOut, type FoundFormula } from "../lib/mathFind";
import { pocketState, type PocketKind } from "../lib/pocket";
import { addDays, dayKey } from "../lib/timestamp";
import { docText } from "../lib/words";
import { planBlocks, planLines, type Busy } from "../lib/workPlan";
import { addPocket, loadPocket, pocketSummary } from "../finance/pocket";
import { favouriteFormulas } from "../watch/formulas";
import { loadConfig, loadEntries, viewOf } from "../routine/routineData";
import { atDayMinute, clockMinute } from "../lib/routine";
import { insertUnder, linesToBlocks } from "./noteOps";

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object" as const, properties, required });
const DATE = { type: "string", description: "YYYY-MM-DD (today if left out)" };
const TITLE = { type: "string", description: "a page title instead of a date" };
const VALUES = { type: "array", description: "new values, e.g. [{name:'r', value:5}]", items: { type: "object", properties: { name: { type: "string" }, value: { type: "number" } }, required: ["name", "value"] } };

export const MORE_TOOLS = [
  {
    name: "pocket",
    description:
      "The person's physical wallet (👛 pocket). Any cash spent, cash put in (ATM, someone gave money) or a count of the cash now goes here: a line under [[pocket]] in that day's note, like 'Hair cut and beard: 350'. Use it whenever they say they paid in cash / from the pocket or wallet, even inside a longer message.",
    parameters: obj(
      {
        kind: { type: "string", enum: ["spend", "add", "count"], description: "spend = cash out (default), add = cash put in, count = what's in the wallet now" },
        amount: { type: "number", description: "rupees" },
        what: { type: "string", description: "short, in their words: 'Hair cut and beard', '2 masala dosas', 'From ATM'" },
        date: DATE,
      },
      ["amount"],
    ),
  },
  { name: "pocket_status", description: "What's left in the pocket (wallet), cash spent today and this month, and the latest pocket lines.", parameters: obj({}) },
  {
    name: "math_add",
    description: "Add a math block (calculates like Apple Math Notes): plain calculator maths, one per line, definitions first and the formula last ('r = 3', 'A = pi*r^2'). Returns its answer. Values defined in lines above it in the note count too.",
    parameters: obj({ lines: { type: "string", description: "plain maths lines, joined with \\n" }, under: { type: "string" }, date: DATE, title: TITLE }, ["lines"]),
  },
  {
    name: "math_solve",
    description: "Ask the math block's AI to work out a problem in words or make a formula ('EMI of 5 lakh at 9% for 3 years'); it is put in the note as a math block with the variables, formula, working and answer.",
    parameters: obj({ question: { type: "string" }, under: { type: "string" }, date: DATE, title: TITLE }, ["question"]),
  },
  {
    name: "math_find",
    description: "Find math formulas already written in the notes (math blocks) and the ⭐ starred ones, newest first, numbered for math_recalc / math_set. They are also shown to the person as cards in the chat they can open or recalculate.",
    parameters: obj({ query: { type: "string", description: "words in the formula, its variables or the question" }, starred_only: { type: "boolean" }, limit: { type: "integer" } }),
  },
  {
    name: "math_recalc",
    description: "Work out formula n (from math_find) again with other values, without changing the note. write=true also adds it to today's note as a new math block with those values.",
    parameters: obj({ n: { type: "integer" }, values: VALUES, write: { type: "boolean" } }, ["n"]),
  },
  {
    name: "math_set",
    description: "Change values in a math block where it is ('drop r to 2'): formula n from math_find (or the last math block of the note named by date/title). A value the block itself defines is rewritten; others become the block's turned values.",
    parameters: obj({ n: { type: "integer" }, values: VALUES, date: DATE, title: TITLE }, ["values"]),
  },
  {
    name: "plan_blocks",
    description:
      "Plan work: split a task into work blocks and breaks (default 50 min work, 10 min break) in the free time of a day, around their usual routine duties (meals, bath, gym, sleep from the Routine) and up to a deadline time. Writes them as ⏰ reminder lines that ring, under a 'Plan' heading in that day's note. Use with add_deadline for a due date.",
    parameters: obj(
      {
        task: { type: "string" },
        minutes: { type: "number", description: "total work minutes wanted (default: fill the free time up to `to`)" },
        date: DATE,
        from: { type: "string", description: "HH:MM to start (default: now or wake-up)" },
        to: { type: "string", description: "HH:MM to finish by (default: bedtime or 22:00)" },
        work: { type: "number", description: "minutes per work block (default 50)" },
        break: { type: "number", description: "minutes per break (default 10)" },
        long_break: { type: "number", description: "a longer break after every 3 blocks (default 25)" },
      },
      ["task"],
    ),
  },
];

/** A formula card shown under the assistant's answer (open it, or work it out again by hand). */
export type FormulaCard = FoundFormula;

export interface MoreCtx {
  store: JournalStore;
  actor: string;
  now: Date;
  formulas?: FoundFormula[];
  cards?: FormulaCard[];
}

type Out = { out: string; bad: boolean };
const ok = (out: string): Out => ({ out, bad: false });
const bad = (out: string): Out => ({ out, bad: true });

export const MORE_WRITES = new Set(["pocket", "math_add", "math_solve", "math_set", "plan_blocks"]);

/** Where math_set writes (for the "second note" check). */
export function moreNoteOf(name: string, a: Record<string, unknown>, ctx: MoreCtx): string | null {
  if (name !== "math_set" || a.n == null) return null;
  const f = ctx.formulas?.[Number(a.n) - 1];
  return f ? (/^\d{4}-\d{2}-\d{2}$/.test(f.note) ? `day:${f.note}` : `page:${f.note.toLowerCase()}`) : null;
}

const valuesOf = (v: unknown): Record<string, number> => {
  const out: Record<string, number> = {};
  if (Array.isArray(v)) for (const x of v) if (x && typeof x === "object" && typeof (x as { name?: unknown }).name === "string") out[String((x as { name: string }).name)] = Number((x as { value?: unknown }).value);
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) out[k] = Number(x);
  return Object.fromEntries(Object.entries(out).filter(([, x]) => Number.isFinite(x)));
};

interface Note {
  name: string;
  doc: JSONContent | null;
  save: (doc: JSONContent) => Promise<unknown>;
}
async function noteFor(ctx: MoreCtx, a: Record<string, unknown>): Promise<Note | string> {
  const title = typeof a.title === "string" ? a.title.trim() : "";
  if (title) {
    const page = await ctx.store.getPage(title);
    if (!page) return `No page called "${title}".`;
    return { name: page.title, doc: page.content, save: (doc) => ctx.store.savePage({ id: page.id, content: doc, plainText: docText(doc), actor: ctx.actor }) };
  }
  const day = typeof a.date === "string" && a.date ? (a.date === "today" ? dayKey(ctx.now) : a.date) : dayKey(ctx.now);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return "date must be YYYY-MM-DD";
  const page = await ctx.store.getDay(day);
  return { name: day, doc: page?.content ?? null, save: (doc) => ctx.store.saveDay({ day, content: doc, plainText: docText(doc), actor: ctx.actor }) };
}
async function saved(note: Note, doc: JSONContent) {
  await window.__journalFlush?.();
  await note.save(doc);
  window.dispatchEvent(new Event("journal:reload-page"));
}
const put = (doc: JSONContent | null, under: unknown, blocks: JSONContent[]) => (typeof under === "string" && under.trim() ? insertUnder(doc, under.trim(), blocks).doc : appendBlocks(doc, [...blocks, { type: "paragraph" }]));

/** All math blocks in the last year of day notes (and pages that match the words), newest first. */
async function allFormulas(store: JournalStore, now: Date, query: string): Promise<FoundFormula[]> {
  const stars = new Set(favouriteFormulas().map((f) => f.expr.trim()));
  const starred = (e: string) => stars.has(e.trim());
  const from = addDays(dayKey(now), -365);
  const out: FoundFormula[] = [];
  const days = (await store.listDays()).filter((d) => d >= from).sort().reverse();
  for (const day of days) {
    const page = await store.getDay(day);
    if (!page?.content || !JSON.stringify(page.content).includes('"mathBlock"')) continue;
    out.push(...mathBlocksIn(page.content, day, starred).reverse());
  }
  if (query.trim()) {
    for (const hit of (await store.search(query)).filter((h) => h.kind === "page").slice(0, 20)) {
      const title = (hit as { title?: string }).title;
      if (!title) continue;
      const page = await store.getPage(title);
      if (page?.content) out.push(...mathBlocksIn(page.content, page.title, starred));
    }
  }
  // ⭐ ones not found in a note (starred, then the note changed): from the favourites list.
  const seen = new Set(out.map((f) => f.expr.trim()));
  for (const f of favouriteFormulas()) {
    if (seen.has(f.expr.trim())) continue;
    const latex = [...f.vars.map((v) => `${v.name} = ${formatAnswer(v.value)}`), f.lhs ? `${f.lhs} = ${f.expr}` : f.expr].join("\n");
    out.push({ note: "⭐ favourites", path: [], latex, ...workOut([], latex), starred: true });
  }
  return out;
}

/** The free time to plan in: wake-up (or now) to bedtime (or `to`), minus the usual routine duties. */
async function busyFor(store: JournalStore, day: string, now: Date): Promise<{ busy: Busy[]; wake: number | null; sleep: number | null }> {
  try {
    const config = await loadConfig(store);
    if (!config.steps.length) return { busy: [], wake: null, sleep: null };
    const entries = await loadEntries(store, config, dayKey(now), true);
    const v = viewOf(config, entries, now.getTime());
    const busy: Busy[] = [];
    const label = (id: string) => config.steps.find((s) => s.id === id);
    const wakeId = config.steps.find((s) => s.health === "wake")?.id ?? config.steps[0]?.id;
    const sleepId = config.steps.find((s) => s.health === "sleep")?.id ?? config.steps[config.steps.length - 1]?.id;
    let wake: number | null = null;
    let sleep: number | null = null;
    if (day === v.day) {
      for (const [id, list] of v.filled) for (const s of list) if (id !== sleepId) busy.push({ start: s.start, end: Math.max(s.end, s.start + 60_000), what: `${label(id)?.icon ?? ""} ${label(id)?.label ?? id}`.trim() });
      for (const p of v.plan) {
        if (p.id === sleepId) sleep = p.start;
        else busy.push({ start: p.start, end: Math.max(p.end, p.start + 60_000), what: `${label(p.id)?.icon ?? ""} ${label(p.id)?.label ?? p.id}`.trim() });
      }
      wake = v.filled.get(wakeId ?? "")?.[0]?.start ?? null;
    } else {
      // Another day: every step at its usual (or ideal) time and length.
      for (const s of config.steps) {
        const st = v.stats.get(s.id);
        const ideal = clockMinute(s.ideal);
        const start = ideal ?? st?.start ?? null;
        if (start === null || (st && st.days >= 3 && st.often < 0.5 && ideal === null)) continue;
        const at = atDayMinute(day, start);
        if (s.id === wakeId) wake = at;
        else if (s.id === sleepId) sleep = at;
        else busy.push({ start: at, end: at + Math.max(1, s.span ? st?.minutes ?? s.minutes ?? 15 : 1) * 60_000, what: `${s.icon} ${s.label}` });
      }
    }
    return { busy, wake, sleep };
  } catch {
    return { busy: [], wake: null, sleep: null };
  }
}

const clock = (day: string, hhmm: unknown): number | null => {
  const m = typeof hhmm === "string" ? /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim()) : null;
  if (!m) return null;
  const [y, mo, d] = day.split("-").map(Number);
  return new Date(y, mo - 1, d, Number(m[1]), Number(m[2])).getTime();
};

/** One of the tools above, or null when it isn't one of them. */
export async function runMoreTool(call: ToolCall, ctx: MoreCtx): Promise<Out | null> {
  const a = (call.arguments ?? {}) as Record<string, unknown>;
  const { store, now } = ctx;
  switch (call.name) {
    case "pocket": {
      const amount = Number(String(a.amount ?? "").replace(/[₹,\s]/g, ""));
      if (!(amount > 0)) return bad("amount must be a number above 0");
      const kind: PocketKind = a.kind === "add" ? "in" : a.kind === "count" ? "count" : "out";
      const day = typeof a.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(a.date) ? a.date : dayKey(now);
      const what = String(a.what ?? "").trim() || (kind === "in" ? "Added" : "Spent");
      await window.__journalFlush?.();
      const r = await addPocket(store, { kind, amount, what }, { day, actor: ctx.actor });
      const s = pocketState(await loadPocket(store));
      return ok(`👛 Added “${r.line}” under [[pocket]] in ${r.day}. ${pocketSummary(s)}.`);
    }
    case "pocket_status": {
      const s = pocketState(await loadPocket(store));
      const last = s.entries.slice(-10).map((e) => `${e.day}: ${e.line}`);
      return ok(`${pocketSummary(s)}.${last.length ? `\nLatest:\n${last.join("\n")}` : "\nNo pocket lines yet."}`);
    }
    case "math_add": {
      const lines = String(a.lines ?? "").replace(/\r/g, "").trim();
      if (!lines) return bad("lines are empty");
      const note = await noteFor(ctx, a);
      if (typeof note === "string") return bad(note);
      const block = { type: "mathBlock", attrs: { latex: lines } };
      const doc = put(note.doc, a.under, [block]);
      await saved(note, doc);
      const mine = mathBlocksIn(doc, note.name).filter((f) => f.latex === lines).pop();
      const missing = mine?.vars.filter((v) => v.value === null).map((v) => v.name) ?? [];
      return ok(`Added a math block to ${note.name}: ${mine?.answer ? `${mine.answer}` : "no answer yet"}${missing.length ? ` (${missing.join(", ")} need a value)` : ""}.`);
    }
    case "math_solve": {
      const q = String(a.question ?? "").trim();
      if (!q) return bad("question is empty");
      const note = await noteFor(ctx, a);
      if (typeof note === "string") return bad(note);
      const r = await solveMath(q);
      if (!r.source.trim()) return bad("The math assistant gave no formula.");
      const block = { type: "mathBlock", attrs: { latex: r.source, solution: JSON.stringify(r.solution) } };
      await saved(note, put(note.doc, a.under, [block]));
      return ok(`Math block added to ${note.name}.\nFormula: ${r.source.split("\n").pop()}\nAnswer: ${r.solution.answer}\nWorking:\n${r.solution.steps.slice(0, 8).join("\n")}`);
    }
    case "math_find": {
      const query = String(a.query ?? "");
      let list = (await allFormulas(store, now, query)).filter((f) => formulaMatches(f, query));
      if (a.starred_only) list = list.filter((f) => f.starred);
      list.sort((x, y) => Number(!!y.starred) - Number(!!x.starred));
      list = list.slice(0, Math.min(30, Number(a.limit) || 12));
      ctx.formulas = list;
      ctx.cards = list;
      if (!list.length) return ok(`No ${a.starred_only ? "starred " : ""}formulas${query ? ` with "${query}"` : ""} in the notes of the last year.`);
      return ok(`${list.length} formula${list.length === 1 ? "" : "s"} (shown to the person as cards they can open or recalculate):\n${list.map(describeFormula).join("\n")}`);
    }
    case "math_recalc": {
      const f = ctx.formulas?.[Number(a.n) - 1];
      if (!f) return bad("No such formula number: call math_find first.");
      const values = valuesOf(a.values);
      // The lines above it are already counted in f.vars: give them all, with the new ones on top.
      const base = Object.fromEntries(f.vars.filter((v) => v.value !== null).map((v) => [v.name, v.value as number]));
      const w = workOut([], f.target, {}, { ...base, ...values });
      if (!w.answer) return bad(`Can't work it out: ${w.vars.filter((v) => v.value === null).map((v) => v.name).join(", ") || "the formula"} needs a value.`);
      ctx.cards = [{ ...f, ...w, latex: f.latex }];
      if (a.write) {
        const note = await noteFor(ctx, {});
        if (typeof note === "string") return bad(note);
        const lines = [...w.vars.map((v) => `${v.name} = ${formatAnswer(v.value ?? 0)}`), f.target].join("\n");
        await saved(note, put(note.doc, undefined, [{ type: "mathBlock", attrs: { latex: lines } }]));
      }
      return ok(`${w.steps.join("\n")}${a.write ? "\n(Added to today's note as a math block.)" : ""}`);
    }
    case "math_set": {
      const values = valuesOf(a.values);
      if (!Object.keys(values).length) return bad("values are empty");
      let f = a.n != null ? ctx.formulas?.[Number(a.n) - 1] : undefined;
      let note: Note | string;
      if (f) {
        if (f.note === "⭐ favourites") return bad("That one is only in the favourites, not in a note: use math_recalc.");
        note = await noteFor(ctx, /^\d{4}-\d{2}-\d{2}$/.test(f.note) ? { date: f.note } : { title: f.note });
      } else {
        note = await noteFor(ctx, a);
        if (typeof note !== "string") f = mathBlocksIn(note.doc, note.name).pop();
      }
      if (typeof note === "string") return bad(note);
      if (!f) return bad(`No math block in ${note.name}.`);
      const doc = JSON.parse(JSON.stringify(note.doc ?? { type: "doc", content: [] })) as JSONContent;
      let node: JSONContent | undefined = doc;
      for (const i of f.path) node = node?.content?.[i];
      if (!node || node.type !== "mathBlock") return bad("That math block has moved: call math_find again.");
      const next = setValuesIn(String(node.attrs?.latex ?? ""), String(node.attrs?.tweaks ?? ""), values);
      node.attrs = { ...(node.attrs ?? {}), latex: next.latex, tweaks: next.tweaks };
      await saved(note, doc);
      const now2 = mathBlocksIn(doc, note.name).find((x) => x.path.join() === f!.path.join());
      return ok(`Changed ${Object.entries(values).map(([k, v]) => `${k} to ${formatAnswer(v)}`).join(", ")} in ${note.name}: ${now2?.answer ?? "worked out again"}.`);
    }
    case "plan_blocks": {
      const task = String(a.task ?? "").trim();
      if (!task) return bad("task is empty");
      const day = typeof a.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(a.date) ? a.date : dayKey(now);
      const { busy, wake, sleep } = await busyFor(store, day, now);
      const [y, mo, d] = day.split("-").map(Number);
      const dayStart = new Date(y, mo - 1, d, 9, 0).getTime();
      const start = clock(day, a.from) ?? Math.max(wake ?? dayStart, day === dayKey(now) ? now.getTime() : 0);
      const end = clock(day, a.to) ?? sleep ?? new Date(y, mo - 1, d, 22, 0).getTime();
      const plan = planBlocks({ start, end, busy, total: Number(a.minutes) || undefined, work: Number(a.work) || 50, brk: Number(a.break) || 10, longBreak: Number(a.long_break) || 25 });
      if (!plan.blocks.length) return bad(`No free time between ${new Date(start).toTimeString().slice(0, 5)} and ${new Date(end).toTimeString().slice(0, 5)} on ${day} (routine: ${busy.map((b) => b.what).join(", ") || "none"}).`);
      const note = await noteFor(ctx, { date: day });
      if (typeof note === "string") return bad(note);
      const lines = planLines(task, plan.blocks);
      const doc = insertUnder(note.doc, "Plan", linesToBlocks(lines.join("\n"))).doc;
      await saved(note, doc);
      const work = plan.blocks.filter((b) => b.kind === "work");
      return ok(
        `Planned ${work.length} work block${work.length === 1 ? "" : "s"} (${plan.workMinutes} min) for “${task}” on ${day} under Plan, each a ⏰ line that rings:\n${lines.join("\n")}` +
          (plan.short ? `\nOnly ${plan.workMinutes} of ${Number(a.minutes)} min fit before ${new Date(end).toTimeString().slice(0, 5)}.` : "") +
          (busy.length ? `\nWorked around: ${[...new Set(busy.filter((b) => b.end > start && b.start < end).map((b) => b.what))].join(", ")}.` : ""),
      );
    }
  }
  return null;
}

