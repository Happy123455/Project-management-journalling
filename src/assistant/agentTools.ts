// The floating agent's own tools (25 Nov, Hapi: "make a table comparing cows and dogs in 2 days'
// note" did nothing). Gemini Live (or the text fallback) calls them directly: make a block in any
// note, change the block it just made in place ("not cows, horses", "add a row for lifespan"),
// remove it. Everything else is the assistant's usual tool list (reminders, money, opening notes…).
//
// Also here: which deletions are small enough to do without asking (Settings › Agent).
import type { JSONContent } from "@tiptap/react";
import type { JournalStore } from "../store";
import type { ToolCall } from "../ai/agent";
import { applyBlockOp } from "../ai/blocks";
import { loadAiSettings } from "../ai/settings";
import { dayKey, formatTimestamp } from "../lib/timestamp";
import { countWords, docText } from "../lib/words";
import { blockFor, blockPrint, liveDay, placeBlock, type LiveBlock, type LivePlan } from "./live";
import { deleteLines, insertUnder } from "./noteOps";
import { noteFor, saved, type NoteCtx } from "./noteSave";
import { dayCheatSheet, shortDay } from "./agentDays";

/** What one bubble remembers between requests: the block it made last. */
export interface AgentMemory {
  last: LiveBlock | null;
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object" as const, properties, required });
const DATE = { type: "string", description: "YYYY-MM-DD of the day note (see the Days list). Leave out for the note on screen." };
const TITLE = { type: "string", description: "a page's title instead of a day" };
const BLOCK = {
  kind: {
    type: "string",
    enum: ["table", "list", "numbered", "checklist", "text", "heading", "quote", "code"],
    description: "table for comparisons and anything with columns; numbered for steps in order; checklist for tasks; heading for a title; quote; code (lines = the code)",
  },
  language: { type: "string", description: "code: its language" },
  headers: { type: "array", items: { type: "string" }, description: "table: the column names" },
  rows: { type: "array", items: { type: "array", items: { type: "string" } }, description: "table: the rows; each row is a list with one short cell per column" },
  lines: { type: "array", items: { type: "string" }, description: "list / checklist / text: one item per line (text: the sentence)" },
};

export const AGENT_BLOCK_TOOLS = [
  {
    name: "make_block",
    description:
      "Make something new in a note: a table (comparisons, anything with columns), a list, a checklist (tasks) or a line of text. It goes at the end of the note on screen unless date or title names another note. Fill it with real, useful content.",
    parameters: obj({ ...BLOCK, date: DATE, title: TITLE, under: { type: "string", description: "optional: a heading or box line to put it under" } }, ["kind"]),
  },
  {
    name: "change_block",
    description:
      "Change the block you made last in this talk, in place, when they correct or extend it ('not cows, horses', 'add a row for lifespan', 'make it shorter', 'add a column'). Give the WHOLE new block (every row), not only the change.",
    parameters: obj(BLOCK, ["kind"]),
  },
  { name: "remove_block", description: "Remove the block you made last in this talk ('delete it', 'undo that', 'never mind').", parameters: obj({}) },
  {
    name: "plan_deadline",
    description:
      "A ⏳ deadline with a worked-out plan: the deadline bar runs from today to the due day, and each step is a time block on its day (e.g. 'plan my ESD exam on 2 Dec': revise unit 1 Thu 18:00 90 min…). Spread the work sensibly before the due day, around the routine (see routine_today), with real, specific steps.",
    parameters: obj(
      {
        title: { type: "string" },
        due: { type: "string", description: "YYYY-MM-DD" },
        time: { type: "string", description: "HH:MM due time (default 23:59)" },
        steps: {
          type: "array",
          description: "the plan, in order",
          items: obj({ text: { type: "string" }, day: { type: "string", description: "YYYY-MM-DD" }, start: { type: "string", description: "HH:MM" }, minutes: { type: "integer" } }, ["text", "day"]),
        },
      },
      ["title", "due", "steps"],
    ),
  },
  {
    name: "routine_today",
    description: "Hapi's routine today: what's been done and when, what's coming next and when it usually happens, habits so far. Read it before planning times, or when asked about the routine.",
    parameters: obj({}),
  },
];
/** Tools here that change a note (routine_today only reads). */
export const AGENT_BLOCK_WRITES = new Set(AGENT_BLOCK_TOOLS.map((t) => t.name).filter((n) => n !== "routine_today"));

type Out = { out: string; bad: boolean };
const ok = (out: string): Out => ({ out, bad: false });
const bad = (out: string): Out => ({ out, bad: true });

const target = (b: LiveBlock) => (b.title ? { title: b.title } : { date: b.day });
const isDay = (name: string) => /^\d{4}-\d{2}-\d{2}$/.test(name);

/** The note a block tool writes to, for the assistant's "second note" check. */
export function agentNoteOf(name: string, a: Record<string, unknown>, mem?: AgentMemory): string | null {
  if (!AGENT_BLOCK_WRITES.has(name)) return null;
  if (name !== "make_block") {
    const last = mem?.last;
    return last ? (last.title ? `page:${last.title.toLowerCase()}` : `day:${last.day}`) : "day:?";
  }
  if (typeof a.title === "string" && a.title.trim()) return `page:${a.title.trim().toLowerCase()}`;
  return `day:${typeof a.date === "string" && a.date ? a.date : liveDay()}`;
}

/** Where it went, said short: "Fri 27 Nov", "today", "“Plans”". */
export const whereSaid = (name: string, now = new Date()) => (isDay(name) ? shortDay(name, dayKey(now)) : `“${name}”`);

/** make_block / change_block / remove_block; null for any other tool. */
export async function runAgentBlockTool(call: ToolCall, ctx: NoteCtx & { live?: AgentMemory }): Promise<Out | null> {
  if (call.name === "routine_today") return ok(await routineToday(ctx.store, ctx.now ?? new Date()));
  if (call.name === "plan_deadline") return planDeadline(call.arguments ?? {}, ctx);
  if (!AGENT_BLOCK_WRITES.has(call.name)) return null;
  const a = call.arguments ?? {};
  const mem = (ctx.live ??= { last: null });
  if (call.name === "remove_block") {
    const last = mem.last;
    if (!last) return bad("You haven't made a block in this talk. To delete other text: read_blocks, then delete_block (or delete_lines).");
    const note = await noteFor(ctx, target(last));
    if (typeof note === "string") return bad(note);
    const { doc, replaced } = placeBlock(note.doc, null, last.json);
    if (!replaced) return bad("That block was changed by hand since; left it. Use read_blocks and delete_block if they still want it gone.");
    mem.last = null;
    return ok(await saved(note, doc, `Removed it from ${note.name}.`));
  }
  const plan: LivePlan = { action: "make", kind: a.kind as LivePlan["kind"], headers: a.headers as string[], rows: a.rows, lines: a.lines as string[] };
  const b = blockFor(plan);
  if (!b) return bad(plan.kind === "table" ? "A table needs headers and rows (each row a list of cells)." : "Give the lines to write.");
  if (call.name === "change_block") {
    const last = mem.last;
    if (!last) return bad("Nothing made yet in this talk: use make_block (or read_blocks + replace_block for existing text).");
    const note = await noteFor(ctx, target(last));
    if (typeof note === "string") return bad(note);
    const { doc, replaced } = placeBlock(note.doc, b.node, last.json);
    if (!replaced) return bad("That block was changed by hand since; use make_block for a new one.");
    mem.last = { ...last, kind: b.kind, json: blockPrint(b.node), shown: b.shown, headers: b.headers, rows: b.rows, lines: b.lines };
    return ok(await saved(note, doc, `Changed the ${b.kind} in ${note.name}. It's now:\n${b.shown}`));
  }
  const title = typeof a.title === "string" ? a.title.trim() : "";
  const date = typeof a.date === "string" && a.date.trim() ? a.date.trim() : liveDay();
  const note = await noteFor(ctx, title ? { title } : { date });
  if (typeof note === "string") return bad(note);
  const under = typeof a.under === "string" ? a.under.trim() : "";
  const doc = under ? insertUnder(note.doc, under, [b.node]).doc : placeBlock(note.doc, b.node, null).doc;
  mem.last = { day: isDay(note.name) ? note.name : "", ...(isDay(note.name) ? {} : { title: note.name }), kind: b.kind, json: blockPrint(b.node), shown: b.shown, headers: b.headers, rows: b.rows, lines: b.lines };
  return ok(await saved(note, doc, `Made a ${b.kind} in ${note.name}${under ? ` under ${under}` : ""}:\n${b.shown}`));
}

const hm = (ms: number) => new Date(ms).toTimeString().slice(0, 5);

/** routine_today: the day so far and what's next, in a few lines. */
export async function routineToday(store: JournalStore, now: Date): Promise<string> {
  const { loadConfig, loadEntries, viewOf } = await import("../routine/routineData");
  const config = await loadConfig(store);
  const today = dayKey(now);
  const view = viewOf(config, await loadEntries(store, config, today), now.getTime());
  const step = (id: string) => config.steps.find((s) => s.id === id);
  const done: string[] = [];
  for (const [id, sessions] of view.filled) {
    const s = step(id);
    if (!s) continue;
    for (const x of sessions) if (!x.estimated) done.push(`${s.icon} ${s.label} ${hm(x.start)}${s.span && !x.open ? `–${hm(x.end)}` : x.open ? " (going on)" : ""}`);
  }
  const next = view.plan.slice(0, 8).map((p) => {
    const s = step(p.id);
    return s ? `${s.icon} ${s.label} ~${hm(p.start)}${s.span ? `–${hm(p.end)}` : ""}` : "";
  });
  const log = view.days.get(view.day);
  const habits = config.habits.map((h) => `${h.icon} ${h.label} ×${log?.habits.get(h.id)?.length ?? 0}`);
  return [
    `Routine day ${view.day}, now ${hm(now.getTime())}.`,
    `Done: ${done.length ? done.join(", ") : "nothing logged yet"}.`,
    `Coming up (usual times): ${next.filter(Boolean).join(", ") || "nothing left"}.`,
    habits.length ? `Habits today: ${habits.join(", ")}.` : "",
    `Steps in the routine: ${config.steps.map((s) => `${s.icon} ${s.label}${s.minutes ? ` (${s.minutes} min)` : ""}`).join(", ")}.`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** plan_deadline: the ⏳ bars to the due day with each step as a time block on its day. */
async function planDeadline(a: Record<string, unknown>, ctx: NoteCtx & { live?: AgentMemory }): Promise<Out> {
  const { deadlineRows } = await import("../editor/deadlineStore");
  const now = ctx.now ?? new Date();
  const due = String(a.due ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) return bad("due must be YYYY-MM-DD");
  const [h, m] = String(a.time ?? "23:59").split(":").map(Number);
  const end = new Date(`${due}T00:00:00`);
  end.setHours(Number.isFinite(h) ? h : 23, Number.isFinite(m) ? m : 59);
  if (end.getTime() <= now.getTime()) return bad("The due time has passed.");
  const title = String(a.title ?? "Deadline").trim() || "Deadline";
  const steps = (Array.isArray(a.steps) ? a.steps : []) as { text?: string; day?: string; start?: string; minutes?: number }[];
  const plans = steps
    .map((s, i) => {
      const day = /^\d{4}-\d{2}-\d{2}$/.test(String(s.day ?? "")) ? String(s.day) : dayKey(now);
      const [sh, sm] = String(s.start ?? "18:00").split(":").map(Number);
      const start = new Date(`${day}T00:00:00`);
      start.setHours(Number.isFinite(sh) ? sh : 18, Number.isFinite(sm) ? sm : 0);
      const mins = Math.max(10, Math.min(8 * 60, Number(s.minutes) || 60));
      return { id: `p${Date.now().toString(36)}${i}`, start: start.getTime(), end: start.getTime() + mins * 60_000, text: String(s.text ?? "").trim(), ai: ctx.actor, kind: "focus" as const };
    })
    .filter((p) => p.text && p.end <= end.getTime() + 60_000 && p.end > now.getTime());
  const rows = deadlineRows(end.getTime(), title, {}, dayKey(now)) as JSONContent[];
  // Each plan sits on the bar of the day it starts.
  for (const r of rows) if (r.type === "deadlineBar" && r.attrs) r.attrs = { ...r.attrs, plans: plans.filter((p) => dayKey(new Date(p.start)) === r.attrs!.day) };
  const lost = plans.filter((p) => !rows.some((r) => r.type === "deadlineBar" && r.attrs?.day === dayKey(new Date(p.start))));
  if (lost.length) {
    const first = rows.find((r) => r.type === "deadlineBar");
    if (first?.attrs) first.attrs = { ...first.attrs, plans: [...((first.attrs.plans as unknown[]) ?? []), ...lost] };
  }
  const note = await noteFor(ctx, { date: dayKey(now) });
  if (typeof note === "string") return bad(note);
  const doc = { ...(note.doc ?? { type: "doc" }), content: [...(note.doc?.content ?? []), ...rows] };
  const list = plans.map((p) => `${shortDay(dayKey(new Date(p.start)), dayKey(now))} ${hm(p.start)}–${hm(p.end)} ${p.text}`).join("\n");
  return ok(await saved(note, doc, `⏳ "${title}" due ${due} ${String(a.time ?? "23:59")} with ${plans.length} step${plans.length === 1 ? "" : "s"}, in today's note:\n${list}`));
}

/** How much a deletion would take away: words, and how many blocks. Null when it can't tell. */
export async function deletionSize(call: ToolCall, ctx: NoteCtx): Promise<{ words: number; blocks: number } | null> {
  const a = call.arguments ?? {};
  if (call.name === "replace_text") return { words: countWords(String(a.find ?? "")), blocks: 0 };
  const note = await noteFor(ctx, a);
  if (typeof note === "string" || !note.doc) return null;
  const before = countWords(docText(note.doc));
  if (call.name === "delete_lines") {
    const want = (Array.isArray(a.lines) ? a.lines : [a.lines]).map((x) => String(x ?? "").trim().toLowerCase()).filter(Boolean);
    const r = deleteLines(note.doc, want, a.keep_empty !== true);
    if (!r.removed) return null;
    const blocks = (note.doc.content?.length ?? 0) - (r.doc.content?.length ?? 0);
    const empties = (note.doc.content ?? []).filter((n) => !docText(n).trim()).length - (r.doc.content ?? []).filter((n) => !docText(n).trim()).length;
    return { words: Math.max(0, before - countWords(docText(r.doc))), blocks: Math.max(1, blocks - Math.max(0, empties)) };
  }
  if (call.name === "delete_block") {
    const r = applyBlockOp(note.doc, { op: "delete", n: Number(a.n) });
    if (typeof r === "string") return null;
    return { words: Math.max(0, before - countWords(docText(r.doc))), blocks: 1 };
  }
  return null;
}

export { DELETE_WORDS } from "../ai/settings";

/** Settings › Agent: may this deletion go ahead without asking? */
export async function smallDelete(call: ToolCall, ctx: NoteCtx): Promise<boolean> {
  const s = loadAiSettings();
  if (s.agentFreeDelete === false) return false;
  const size = await deletionSize(call, ctx).catch(() => null);
  if (!size) return false;
  return size.words <= (s.agentDeleteWords ?? 30) || (s.agentDeleteBlock !== false && size.blocks <= 1);
}

/** What the floating agent is told (Gemini Live and the text fallback alike). */
export function agentSystem(o: { name: string; now: Date; onScreen: string | null; last: LiveBlock | null; speak?: boolean }): string {
  const last = o.last ? `\nThe block you made last (in ${o.last.title ? `“${o.last.title}”` : o.last.day}, a ${o.last.kind}):\n${o.last.shown.slice(0, 2500)}\n` : "";
  return (
    `You are ${o.name}, a voice helper inside Hapi's journal app. Now: ${formatTimestamp(o.now)}. ` +
    "Hapi taps and says one request (the turn ends when they stop talking). Do it straight away with the tools: never only talk about doing it, never ask a question back, pick the most likely meaning. " +
    "Speech can be unclear (Indian English, sometimes Gujarati or Hindi): go by what makes sense in a journal. If it's noise, not a request, or words you can't make sense of, call nothing and say \"Didn't catch that, say it again?\" rather than guessing.\n" +
    `${dayCheatSheet(o.now, o.onScreen)}\n` +
    "Making things: make_block makes any block (table for comparisons, numbered for steps, list, checklist for tasks, heading, quote, code, text), with the date (from the Days list) or title when they name a note, filled with real, specific content; tables 4-7 rows unless they say. " +
    "A deadline, exam, submission or project due on a day ('plan my ESD exam on 2 Dec'): routine_today first, then plan_deadline with real steps spread over the days before it, at free times around the routine (never on top of sleep, meals or gym), 45-120 min each, the last step a review the day before. " +
    "Their routine, what's next, when they usually do something: routine_today. " +
    "Fixing or extending what you just made: change_block with the whole new block. 'Delete it', 'undo that': remove_block. " +
    "Other jobs: reminders add_reminder (24-hour HH:MM, with date), deadlines add_deadline, cash from the pocket pocket, open a note open, find things search or day_list, tasks find_tasks / tick_task, maths math_add. " +
    "Writing their own words into a note ('write that I finished the gym at 7', a log line): append with the date, in their words (log_routine only when they say to log a routine step by its name). To change or delete text that's already there: read_blocks first, then replace_block / delete_block (or delete_lines). " +
    "Adding a row or item that's already there: change that one instead, never a duplicate. Call each tool once per request. If a tool answers with an error, try the other way (e.g. append) before you answer. " +
    "Write in the language they speak. Use as few tool calls as you can. " +
    (o.speak ? "After the tools, say what you did in at most 8 words." : "After the tools, answer in at most 8 words: what you did and where.") +
    last
  );
}

/** The tools the agent offers: its block tools, then the assistant's (add_table is make_block here). */
export async function agentToolList(): Promise<{ name: string; description: string; parameters: { properties: Record<string, unknown>; required?: string[] } }[]> {
  const { assistantToolList } = await import("./tools");
  const skip = new Set(["add_table", "save_graph", "add_rule", "read_aloud", "usage_counts"]);
  return [...AGENT_BLOCK_TOOLS, ...assistantToolList().filter((t) => !skip.has(t.name))];
}

/** For tests and the probe: a store-bound context. */
export const agentCtx = (store: JournalStore, actor: string, now = new Date()) => ({ store, actor, now });
