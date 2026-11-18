// Item 13: runs what the person asks the assistant. The fast path first (no AI); otherwise Gemini
// with the journal's tools. A long job (a block of lines, or one sentence with several "then"s)
// is split into steps and run one step at a time, each told what the earlier steps did, so a list
// of any length gets done turn by turn. Single commands use the cheap chat model; long jobs Flash.
import type { JournalStore } from "../store";
import { askAi } from "../ai/client";
import { AI_OPEN_EVENT } from "../ai/journalTools";
import { geminiAgent } from "../ai/geminiTools";
import { loadAiSettings, modelFor } from "../ai/settings";
import { dayKey, formatTimestamp } from "../lib/timestamp";
import { fastPath } from "./fastPath";
import { assistantToolList, runAssistantTool, type RunCtx } from "./tools";
import type { FoundFormula } from "../lib/mathFind";
import { pocketFromSentence } from "../lib/pocket";
import { addPocket, loadPocket, pocketSummary } from "../finance/pocket";
import { pocketState } from "../lib/pocket";
import { cursorFx } from "./AgentCursors";
import { bankFromSentence } from "../lib/bank";
import { addBank } from "../finance/bank";

export const ASSISTANT_ACTOR = "Assistant";

export type StepStatus = "wait" | "run" | "done" | "fail" | "skip";
export interface Step {
  text: string;
  status: StepStatus;
  /** Tools used ("✓ open “2026-11-03”"). */
  lines: string[];
  answer?: string;
}

export interface Turn {
  role: "user" | "assistant";
  content: string;
}

export interface RunOpts {
  store: JournalStore;
  text: string;
  /** The conversation so far (follow-ups keep their context). */
  history?: Turn[];
  onUpdate?: (steps: Step[]) => void;
  confirm?: (question: string) => Promise<boolean>;
  signal?: AbortSignal;
  /** Who the edits are written as (each floating agent has its own name, so its Undo is its own). */
  actor?: string;
  now?: Date;
}

export interface RunResult {
  answer: string;
  steps: Step[];
  /** No AI was used. */
  fast: boolean;
  /** Formulas to show as cards (math_find / math_recalc). */
  cards?: FoundFormula[];
}

/** Strips "1.", "-", "•", "[ ]" from the start of a line of steps. */
const stepLine = (l: string) => l.replace(/^\s*(?:\d+[.)]|[-*•]|\[[ x]\])\s*/i, "").trim();

/** A block of lines is a list of steps as written; one line stays one step (the AI may split it). */
export function linesAsSteps(text: string): string[] {
  return text.split("\n").map(stepLine).filter(Boolean);
}

/** Does one sentence hold several jobs ("find …, then open …, and summarise …")? */
export const looksLong = (text: string) => text.length > 140 || (text.match(/\b(?:then|after that|and then|next|also)\b|;/gi)?.length ?? 0) >= 2;

async function splitSentence(text: string): Promise<string[]> {
  try {
    const r = await askAi<{ steps: string[] }>({
      task: "chat",
      provider: "gemini",
      cloud: true,
      system:
        "Split the person's request into the separate steps it asks for, in order, each a short instruction that can be done on its own, in their words. " +
        "Keep every detail (names, numbers, where things go). Don't add steps. Words like 'it' or 'that' refer to the step before; keep them. " +
        'Reply as JSON: {"steps": ["…", "…"]}.',
      text,
      schema: { type: "object", properties: { steps: { type: "array", items: { type: "string" } } }, required: ["steps"] },
      maxTokens: 800,
    });
    const steps = (r.json?.steps ?? []).map((s) => String(s).trim()).filter(Boolean);
    return steps.length ? steps.slice(0, 40) : [text];
  } catch {
    return [text];
  }
}

export function assistantSystem(now: Date): string {
  return (
    `You are the assistant inside the person's journal app. Now: ${formatTimestamp(now)} (today is ${dayKey(now)}). ` +
    "Do what they ask with the tools, then answer briefly: one or two plain sentences, or exactly what they asked for (a summary, a number, a list). " +
    "Don't ask questions back: pick the most likely meaning and say which you chose. Day notes are named YYYY-MM-DD. " +
    "To show a note use open (new_tab: true when they say new tab). 'The Nth day of X' or 'the first day I wrote about X': day_list with X, then count. " +
    "'Paste/put/copy a task under Y': find_tasks, then copy_task with under Y (today unless they say another day). Plain text under a heading: put_under. " +
    "Tables of top files, tags, links or memes: usage_counts, then add_table. Reminders: add_reminder (24-hour HH:MM). Deadlines: add_deadline. " +
    "Photos, videos, memes, GIFs, sounds, audio or files: find_media then add_media ('my latest/recent photo' = source phone, newest first; files already in the journal = journal; memes, GIFs, meme sounds = memes). Never write ![..](..), file names or '/meme' as text instead. " +
    "Read aloud with read_aloud. To summarise a note, read it first (read_day / read_page). " +
    "Cash: whenever they mention paying in cash, from their pocket or wallet ('haircut 350 from my pocket', 'spent 370 on food from pocket'), call pocket (spend/add/count) as well as anything else asked; ATM cash = pocket add. " +
    "Maths: new calculations or formulas go in math blocks (math_add with plain maths lines, or math_solve for a problem in words). Averages and totals: a list line then a function, e.g. 'marks = 80, 90, 70' and 'average = avg(marks)' (also sum, min, max, median, count). 'my formulas', 'the formula I starred' = math_find (the person sees them as cards); 'change r to 5 / drop the price to 300' = math_set, or math_recalc to only see the answer. " +
    "Planning: a deadline = add_deadline (+ add_reminder lines the day before and on the day); work/break blocks or 'plan my day/evening for X' = plan_blocks, which fits blocks around their routine duties. " +
    "Be quick: use as few tool calls as you can, don't re-read a note you just changed, and don't explain your plan. " +
    "Deleting several lines or paragraphs they asked for: delete_lines once with every line (empty lines go with them), not one call per line. " +
    "Never delete or rewrite anything they didn't ask you to. If a step can't be done, say why in one sentence."
  );
}

/** Opens a note the fast path found (a page only if it exists: otherwise the AI tries). */
async function openFast(store: JournalStore, f: Extract<ReturnType<typeof fastPath>, { kind: "open" }>): Promise<string | null> {
  let target = f.day ?? "";
  if (f.page) {
    const page = await store.getPage(f.page);
    if (!page) return null;
    target = page.title;
  }
  if (f.end) {
    window.dispatchEvent(new Event("journal:write-at-end"));
    return "Opened the end of today.";
  }
  window.dispatchEvent(new CustomEvent(AI_OPEN_EVENT, { detail: { target, newTab: f.newTab, now: true } }));
  return `Opened ${f.label}${f.newTab ? " in a new tab" : ""}.`;
}

/** One step: the fast path when it fits, else the AI with tools. */
async function runStep(step: Step, opts: RunOpts, ctx: RunCtx, model: string, before: string): Promise<{ answer: string; fast: boolean }> {
  const fast = fastPath(step.text, ctx.now);
  if (fast?.kind === "answer") return { answer: fast.text, fast: true };
  // "Haircut 350 from my pocket": straight into today's [[pocket]] box, no AI needed (and it
  // works when Gemini is busy). A longer message (more to write) goes to the AI, which calls pocket.
  const cash = step.text.length < 160 && !/\b(?:and|then|also|write|note)\b.*\b(?:about|that|how)\b/i.test(step.text) ? pocketFromSentence(step.text) : null;
  if (cash) {
    await window.__journalFlush?.();
    cursorFx({ key: ctx.actor, phase: "act", tool: "pocket", text: cash.what });
    const r = await addPocket(opts.store, cash, { actor: ctx.actor });
    step.lines.push(`✓ pocket “${r.line}”`);
    return { answer: `👛 Added “${r.line}” under [[pocket]] in today's note. ${pocketSummary(pocketState(await loadPocket(opts.store)))}.`, fast: true };
  }
  // "Bank balance 45230": today's [[bank]] box, no AI (kept apart from the pocket).
  const bank = step.text.length < 80 ? bankFromSentence(step.text) : null;
  if (bank) {
    await window.__journalFlush?.();
    const r = await addBank(opts.store, bank, { actor: ctx.actor });
    step.lines.push(`✓ bank “${r.line}”`);
    return { answer: `🏦 Saved “${r.line}” under [[bank]] in today's note.`, fast: true };
  }
  if (fast?.kind === "math") {
    const r = await runAssistantTool({ name: "math_add", arguments: { lines: fast.lines } }, ctx);
    step.lines.push(`${r.bad ? "⚠" : "✓"} math_add “${fast.label}”`);
    if (!r.bad) return { answer: `🧮 ${r.out}`, fast: true };
  }
  if (fast?.kind === "open") {
    const said = await openFast(opts.store, fast);
    if (said) return { answer: said, fast: true };
  }
  const messages: Turn[] = [...(opts.history ?? []).slice(-8), { role: "user", content: before ? `${before}\n\nNow do only this step: ${step.text}` : step.text }];
  const r = await geminiAgent({
    store: opts.store,
    system: assistantSystem(ctx.now),
    messages,
    actor: ctx.actor,
    signal: opts.signal,
    model,
    maxRounds: 10,
    tools: assistantToolList(),
    runTool: (call) => runAssistantTool(call, ctx),
    onStep: (line) => {
      step.lines.push(line);
      opts.onUpdate?.([]);
    },
  });
  return { answer: r.text, fast: false };
}

export async function runAssistant(opts: RunOpts): Promise<RunResult> {
  const now = opts.now ?? new Date();
  const text = opts.text.trim();
  const ctx: RunCtx = { store: opts.store, actor: opts.actor ?? ASSISTANT_ACTOR, now, confirm: opts.confirm, touched: new Set(), found: [], opened: [] };
  const lines = linesAsSteps(text);
  const parts = lines.length > 1 ? lines : looksLong(text) && !fastPath(text, now) ? await splitSentence(text) : [text];
  const steps: Step[] = parts.map((t) => ({ text: t, status: "wait", lines: [] }));
  const update = () => opts.onUpdate?.(steps.map((s) => ({ ...s, lines: [...s.lines] })));
  update();
  const settings = { ...loadAiSettings(), provider: "gemini" as const };
  const model = steps.length > 1 ? modelFor(settings, "grammar") : modelFor(settings, "chat");
  let allFast = true;
  const done: string[] = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (opts.signal?.aborted) {
      steps.slice(i).forEach((x) => (x.status = "skip"));
      break;
    }
    s.status = "run";
    update();
    const before = steps.length > 1 ? `The whole job (${steps.length} steps):\n${steps.map((x, k) => `${k + 1}. ${x.text}`).join("\n")}${done.length ? `\n\nDone so far:\n${done.join("\n")}` : ""}` : "";
    try {
      const r = await runStep(s, { ...opts, onUpdate: () => update() }, ctx, model, before);
      s.answer = r.answer;
      s.status = "done";
      allFast &&= r.fast;
      done.push(`${i + 1}. ${s.text} → ${r.answer.slice(0, 1500)}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if ((e as { name?: string })?.name === "AbortError") {
        s.status = "skip";
        steps.slice(i + 1).forEach((x) => (x.status = "skip"));
        update();
        break;
      }
      s.status = "fail";
      s.answer = msg;
      allFast = false;
      done.push(`${i + 1}. ${s.text} → failed: ${msg}`);
    }
    update();
  }
  const finished = steps.filter((s) => s.status === "done" || s.status === "fail");
  const answer =
    steps.length === 1
      ? steps[0].answer ?? "Stopped."
      : finished.length
        ? (finished[finished.length - 1].answer ?? "") + (steps.some((s) => s.status === "fail") ? `\n(${steps.filter((s) => s.status === "fail").length} step(s) didn't work: see the list.)` : "")
        : "Stopped.";
  return { answer, steps, fast: allFast, ...(ctx.cards?.length ? { cards: ctx.cards } : {}) };
}
