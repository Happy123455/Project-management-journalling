// 🎲 The consequence engine (Life RPG): an honest strategist for one long-running situation (a
// project, a goal, a person). It reads every journal entry linked to the page, cleans the writing
// for reading (the note itself is never changed), asks for missing facts first, judges through three
// lenses, warns about loops and sunk costs, maps the next moves as a choice tree with their
// 2nd- and 3rd-order consequences, and learns from what really happened after a move was locked in.
//
// This file is the pure part (no AI calls, no store): records, the page they live on, raw-text
// stress signals, the AI context and prompts, answer schemas and normalising, calibration stats,
// the local loop check, and the choice tree as a graph. src/consequence/engine.ts runs it.
import { hash } from "../sync/lineIds";
import { addFeatures, addPrompt, emptyGraph } from "./graphFormat";
import type { PromptMapData } from "./canvasLoadout";

// ───── Records ─────

export type PathId = "A" | "B" | "C" | "D";
export type Risk = "low" | "medium" | "high";
export type Felt = "better" | "as-expected" | "worse";

export interface Path {
  id: PathId;
  /** hold | strategic | direct | exit */
  style: string;
  title: string;
  /** Exactly what to do (or say), and when. */
  action: string;
  /** What happens right away. */
  immediate: string;
  /** How the other side most likely reacts to it. */
  counter: string;
  /** Where it leads in 3–6 months (2nd order). */
  months: string;
  /** The long-run outcome (3rd order). */
  longRun: string;
  risk: Risk;
  /** Chance (0–100) it moves the situation towards the goal. */
  odds: number;
  /** What it costs in time, energy, money or relationships. */
  cost: string;
}

export interface Analysis {
  summary: string;
  stress: { level: number; reading: string };
  loops: { pattern: string; when: string; warning: string }[];
  sunkCost: { meter: number; call: "continue" | "reassess" | "walk away"; why: string };
  lenses: { mine: string; theirs: string; observer: string; blindSpot: string };
  paths: Path[];
  verdict: { path: PathId; text: string };
}

export interface SituationState {
  goal: string;
  summary: string;
  people: { name: string; patterns: string[] }[];
  leverage: string;
  blindSpots: string[];
  keyEvents: string[];
  failedMoves: string[];
  lessons: string[];
}

export interface StateRec extends SituationState {
  kind: "state";
  id: "state";
  at: string;
}
export interface RunRec {
  kind: "run";
  id: string;
  at: string;
  /** Who wrote it (the AI's actor name) and with which model. */
  by: string;
  model: string;
  entries: number;
  analysis: Analysis;
}
/** A question the engine asked before judging, and Hapi's answer (Hapi's own words: never pruned). */
export interface FactRec {
  kind: "fact";
  id: string;
  at: string;
  q: string;
  a: string;
}
export interface Outcome {
  at: string;
  text: string;
  felt: Felt;
  /** How close the prediction was (0–100), from the calibration; missing until it ran. */
  match?: number;
  surprise?: string;
  lesson?: string;
  /** The move failed at what it was for. */
  failed?: boolean;
  by?: string;
}
export interface MoveRec {
  kind: "move";
  id: string;
  at: string;
  /** The day it was locked in. */
  day: string;
  runId?: string;
  path: PathId | "custom";
  action: string;
  predicted: { immediate: string; months: string; odds?: number; risk?: Risk };
  /** When to look back and log what happened. */
  checkDay: string;
  outcome?: Outcome;
}
export type EngineRec = StateRec | RunRec | FactRec | MoveRec;

/** A cleaned entry (for reading only; the note keeps the raw text). Kept on its own page. */
export interface CleanRec {
  kind: "clean";
  id: string;
  day: string;
  clean: string;
  stress?: number;
  tone?: string;
  by: string;
}

export interface EngineData {
  state: StateRec | null;
  runs: RunRec[];
  facts: FactRec[];
  moves: MoveRec[];
}

/** The page the engine keeps its records on (syncs like any page), and the one for cleaned entries. */
export const ENGINE_PREFIX = "Consequence engine · ";
export const CLEAN_PREFIX = "Consequence clean · ";
export const enginePage = (title: string) => ENGINE_PREFIX + title;
export const cleanPage = (title: string) => CLEAN_PREFIX + title;

/** Pages that are the app's own data, not a situation to read (no engine on them). */
const INTERNAL = [ENGINE_PREFIX, CLEAN_PREFIX, "AI chat data · ", "Graph · ", "AI decision models", "AI rules"];
export const isInternalPage = (title: string) => INTERNAL.some((p) => title.startsWith(p));

/** Runs kept on the page (older ones are dropped; facts, moves and outcomes are always kept). */
export const KEEP_RUNS = 12;

/**
 * JSON for the page: "[[" and "#" are written as escapes, so the records never count as links or
 * tags (the engine page doesn't show up as a mention of the project, or under a #tag).
 */
export function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/\[\[/g, "[\\u005b").replace(/#/g, "\\u0023");
}

type Node = { type?: string; attrs?: Record<string, unknown>; content?: Node[]; text?: string };

/** Every record on a page (code blocks of JSON); anything unreadable is skipped. */
export function parseRecords<T extends { kind: string; id: string }>(content: Node | null | undefined): T[] {
  const out: T[] = [];
  for (const b of content?.content ?? []) {
    if (b.type !== "codeBlock") continue;
    const text = (b.content ?? []).map((t) => t.text ?? "").join("");
    try {
      const r = JSON.parse(text) as T;
      if (r && typeof r.kind === "string" && typeof r.id === "string") out.push(r);
    } catch {
      // Hand-edited or half-synced: left out.
    }
  }
  return out;
}

/**
 * A page holding records: one code block each, with the record's id as the line id, so a sync
 * merge of two devices' versions matches records one by one (never a broken JSON).
 */
export function recordsDoc(records: { kind: string; id: string }[]) {
  return {
    type: "doc",
    content: records.map((r) => ({ type: "codeBlock", attrs: { language: "json", lid: `ce-${r.kind}-${r.id}` }, content: [{ type: "text", text: safeJson(r) }] })),
  };
}

export function engineData(records: EngineRec[]): EngineData {
  const by = <K extends EngineRec["kind"]>(k: K) => records.filter((r): r is Extract<EngineRec, { kind: K }> => r.kind === k).sort((a, b) => a.at.localeCompare(b.at));
  const states = by("state");
  return { state: states[states.length - 1] ?? null, runs: by("run"), facts: by("fact"), moves: by("move") };
}

/** The records to save: the state, the facts, the newest runs and every move, in a stable order. */
export function engineRecords(d: EngineData): EngineRec[] {
  return [...(d.state ? [d.state] : []), ...d.facts, ...d.runs.slice(-KEEP_RUNS), ...d.moves];
}

export const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// ───── Entries ─────

export interface Entry {
  day: string;
  /** The entry as written (typos and all: they are signals). */
  raw: string;
  /** Changes when the entry is edited, so its clean copy is made again. */
  key: string;
  /** Hour it was written, when known (late nights are a signal). */
  hour?: number;
}

export const entryKey = (day: string, raw: string) => hash(`${day}\n${raw}`);

// ───── Raw-text signals (free, on the device) ─────

export interface Signals {
  /** 0 calm … 100 very stressed: a rough count, a hint for the AI and a dot in the list. */
  score: number;
  notes: string[];
}

/**
 * Stress signals in raw writing: repeated words, stretched words ("sooo"), shouting in capitals,
 * piled-up "!!" or "??", run-on sentences, a lowercase "i", and writing late at night.
 */
export function rawSignals(text: string, hour?: number): Signals {
  const notes: string[] = [];
  let score = 0;
  const words = text.match(/[\p{L}']+/gu) ?? [];
  if (words.length < 3) return { score: 0, notes };
  let repeats = 0;
  for (let i = 1; i < words.length; i++) if (words[i].length > 1 && words[i].toLowerCase() === words[i - 1].toLowerCase()) repeats++;
  if (repeats) {
    score += Math.min(20, repeats * 8);
    notes.push(`${repeats} doubled word${repeats > 1 ? "s" : ""}`);
  }
  const stretched = words.filter((w) => /(\p{L})\1\1/u.test(w)).length;
  if (stretched) {
    score += Math.min(15, stretched * 6);
    notes.push("stretched words");
  }
  const caps = words.filter((w) => w.length >= 3 && w === w.toUpperCase() && w !== w.toLowerCase()).length;
  if (caps >= 2 || (caps && caps / words.length > 0.1)) {
    score += Math.min(25, caps * 6);
    notes.push("shouting in capitals");
  }
  const marks = (text.match(/[!?]{2,}/g) ?? []).length;
  if (marks) {
    score += Math.min(20, marks * 7);
    notes.push(`"!!" or "??" ×${marks}`);
  }
  const sentences = text.split(/[.!?।\n]+/).map((s) => s.trim()).filter((s) => s.split(/\s+/).length > 2);
  const longest = Math.max(0, ...sentences.map((s) => s.split(/\s+/).length));
  if (longest > 45) {
    score += 15;
    notes.push("run-on sentences");
  }
  const lowerI = (text.match(/(^|\s)i(\s|')/g) ?? []).length;
  if (lowerI >= 2) {
    score += 8;
    notes.push("typed in a rush");
  }
  if (hour !== undefined && (hour >= 0 && hour < 5)) {
    score += 15;
    notes.push(`late night (${String(hour).padStart(2, "0")}:xx)`);
  }
  return { score: Math.min(100, score), notes };
}

// ───── Stats (free, on the device) ─────

const DAY = 86_400_000;
const at = (d: string) => Date.parse(`${d}T12:00:00Z`);

export interface SituationStats {
  firstDay: string | null;
  days: number;
  entries: number;
  last30: number;
  /** Average signal score of the last 5 entries, and of all of them. */
  recentStress: number;
  stress: number;
  /** Logged outcomes and how close the predictions were (average match). */
  logged: number;
  accuracy: number | null;
  /** Moves waiting for their outcome; how many of them are past their check day. */
  pending: number;
  due: number;
}

export function situationStats(entries: Entry[], moves: MoveRec[], today: string): SituationStats {
  const sorted = [...entries].sort((a, b) => a.day.localeCompare(b.day));
  const firstDay = sorted[0]?.day ?? null;
  const scores = sorted.map((e) => rawSignals(e.raw, e.hour).score);
  const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);
  const matched = moves.filter((m) => typeof m.outcome?.match === "number");
  const pending = moves.filter((m) => !m.outcome);
  return {
    firstDay,
    days: firstDay ? Math.round((at(today) - at(firstDay)) / DAY) + 1 : 0,
    entries: sorted.length,
    last30: sorted.filter((e) => at(today) - at(e.day) < 30 * DAY).length,
    recentStress: avg(scores.slice(-5)),
    stress: avg(scores),
    logged: moves.filter((m) => m.outcome).length,
    accuracy: matched.length ? avg(matched.map((m) => m.outcome!.match!)) : null,
    pending: pending.length,
    due: pending.filter((m) => m.checkDay <= today).length,
  };
}

// ───── Loop check (free, on the device) ─────

const STOP = new Set(["that", "this", "with", "from", "have", "will", "what", "when", "then", "they", "them", "their", "there", "about", "into", "just", "also", "some", "more", "like", "your", "were", "been", "would", "could", "should", "again", "very", "really", "make", "tell", "said", "send"]);
const stems = (t: string) => new Set((t.toLowerCase().match(/\p{L}{4,}/gu) ?? []).filter((w) => !STOP.has(w)).map((w) => w.slice(0, 6)));

/** How alike two texts are by their words (0–1). */
export function overlap(a: string, b: string): number {
  const x = stems(a);
  const y = stems(b);
  if (!x.size || !y.size) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return shared / Math.min(x.size, y.size);
}

/** Earlier moves that went worse than hoped and look like this one: the loop warning on a path. */
export function similarFailed(action: string, moves: MoveRec[], threshold = 0.5): MoveRec[] {
  return moves.filter((m) => m.outcome && (m.outcome.failed || m.outcome.felt === "worse") && overlap(action, m.action) >= threshold);
}

// ───── What the AI reads ─────

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * The whole situation as text, within `budget` characters: the facts and history first, then
 * the entries as written, newest kept whole. When it doesn't all fit, older entries become
 * one-line digests (their clean copy's start) and the oldest are left to the rolling state.
 */
export function situationContext(o: {
  title: string;
  today: string;
  page: string;
  entries: Entry[];
  clean: Map<string, CleanRec>;
  data: EngineData;
  now?: string;
  budget: number;
}): string {
  const stats = situationStats(o.entries, o.data.moves, o.today);
  const head: string[] = [
    `# Situation: ${o.title}`,
    `Today is ${o.today}. First entry ${stats.firstDay ?? "—"} (${stats.days} days, ${stats.entries} entries, ${stats.last30} in the last 30 days).`,
    `Raw-writing stress hint (0–100, a simple counter): recent ${stats.recentStress}, overall ${stats.stress}.`,
  ];
  if (o.page.trim()) head.push("", "## The page's own notes", clip(o.page.trim(), 4000));
  if (o.data.state) {
    const { kind: _k, id: _i, at: when, ...s } = o.data.state;
    head.push("", `## What you concluded before (rolling state, ${when.slice(0, 10)})`, JSON.stringify(s));
  }
  if (o.data.moves.length) {
    head.push("", "## Reality log: moves Hapi locked in, what was predicted, what really happened");
    for (const m of o.data.moves.slice(-20)) {
      const out = m.outcome
        ? `REALLY: ${clip(m.outcome.text, 500)} (felt ${m.outcome.felt}${typeof m.outcome.match === "number" ? `, prediction match ${m.outcome.match}%` : ""}${m.outcome.lesson ? `; lesson: ${m.outcome.lesson}` : ""})`
        : `not logged yet (check ${m.checkDay})`;
      head.push(`- ${m.day} · ${m.path === "custom" ? "own move" : `path ${m.path}`}: ${clip(m.action, 300)} | PREDICTED: ${clip(m.predicted.immediate, 200)} → ${clip(m.predicted.months, 200)} | ${out}`);
    }
  }
  if (o.data.facts.length) {
    head.push("", "## Facts Hapi gave when asked");
    for (const f of o.data.facts.slice(-30)) head.push(`- ${f.at.slice(0, 10)} Q: ${f.q} A: ${clip(f.a, 600)}`);
  }
  const tail: string[] = [];
  if (o.now?.trim()) tail.push("", "## Right now (Hapi just wrote this)", o.now.trim());

  let room = o.budget - head.join("\n").length - tail.join("\n").length - 200;
  const sorted = [...o.entries].sort((a, b) => a.day.localeCompare(b.day));
  const full: string[] = [];
  let i = sorted.length - 1;
  // Newest entries whole, with their signals, until 70% of the room is used.
  const fullRoom = room * 0.7;
  let used = 0;
  for (; i >= 0; i--) {
    const e = sorted[i];
    const sig = rawSignals(e.raw, e.hour);
    const block = `### ${e.day}${e.hour !== undefined ? ` ${String(e.hour).padStart(2, "0")}h` : ""} · signals ${sig.score}${sig.notes.length ? ` (${sig.notes.join(", ")})` : ""}\n${e.raw}`;
    if (used + block.length > fullRoom && full.length) break;
    full.unshift(block);
    used += block.length + 2;
  }
  room -= used;
  // Older ones as digests.
  const digests: string[] = [];
  for (; i >= 0; i--) {
    const e = sorted[i];
    const text = (o.clean.get(e.key)?.clean ?? e.raw).replace(/\s+/g, " ");
    const line = `- ${e.day}: ${clip(text, 220)}`;
    if (line.length > room) break;
    digests.unshift(line);
    room -= line.length + 1;
  }
  const left = i + 1;
  const body: string[] = [];
  if (left > 0) body.push("", `(${left} oldest entr${left === 1 ? "y is" : "ies are"} left out; the rolling state above carries their gist.)`);
  if (digests.length) body.push("", "## Older entries (one-line digests)", ...digests);
  body.push("", "## Entries as written (raw, oldest first)", ...(full.length ? full : ["(no entries yet)"]));
  return [...head, ...body, ...tail].join("\n");
}

// ───── Prompts ─────

export const ENGINE_SYSTEM = `You are the Consequence Engine inside Hapi's journal: an objective strategist and an honest second-order thinker. You read the whole history of one long-running situation (a project, a goal, or dealings with a person) and tell Hapi the truth about it, then map the next moves like a choice-based game where every choice has consequences. Talk to Hapi as "you".

How you work:
1. No flattery, no sycophancy. Don't validate feelings to be nice, don't take Hapi's side by default, don't soften bad news. Be just as plain when things are going well: if a move is good, say so. Never invent a problem to look balanced.
2. Journals are written by an unreliable narrator: they leave out inconvenient facts, the other side's reasons and the writer's own part. Reconstruct what most likely happened and name what's missing.
3. Read the raw text as signals: rushed phrasing, repetition, typos, capitals and late-night writing show stress, ego or exhaustion. Say what state Hapi seems to be writing from and how it may bend the judgement. The signal numbers are a rough counter, only a hint.
4. Use the history: older entries, the facts Hapi gave when asked, and above all the reality log (moves locked in, what was predicted, what really happened). What really happened outweighs any prediction. Learn how each person actually behaves.
5. Loop check: if Hapi is about to repeat an argument, boundary, strategy or move that already failed or went in circles, say so and cite when (dates).
6. Sunk cost: judge whether the goal is still worth the time, energy and money it costs. Meter 0–100: 0 = clearly worth continuing, 100 = walking away is clearly smartest. From 60 up, include path D (exit / cut losses).
7. Three lenses before any judgement: Hapi's view (what they feel and want), the other side's view (their incentives, fears, ego, leverage, how they see Hapi's actions), and a cold observer's view (the real balance of power, where Hapi is right, where wrong). Name the blind spot.
8. Think in 2nd and 3rd order: for every move, what happens right away, how the other side counter-reacts, where that leads in 3–6 months, and the long-run outcome. Don't stop at tomorrow.
9. Paths: A = hold / observe (conservative), B = strategic / calculated, C = direct / high-risk, D = exit / cut losses (only when it's a real option). Each must be a concrete action (what to do or say, and when), honest and ethical: no deception, manipulation, threats, or anything that harms someone. If Hapi's own behaviour is the problem, the paths should address it.
10. Odds are honest estimates (0–100) that the path moves the situation towards Hapi's real goal; keep them consistent with the reality log.
11. The verdict names one path and says why in a few direct sentences.
12. Cite entries by date when you rely on them. Short, plain sentences; write in the language Hapi mostly writes in.
13. Also update the rolling state (goal, people and their observed patterns, leverage, blind spots, key dated events, failed moves, lessons) so the next reading can start from it; keep it compact (it replaces the old one, so carry over what still matters).
14. If anything suggests Hapi may be in danger or thinking of harming themself, say so kindly in the summary first and suggest talking to someone they trust or a helpline.`;

export const CLEAN_SYSTEM = `You help Hapi keep a readable copy of their journal. For each numbered entry, write a clean version: correct grammar, spelling, punctuation and flow, keep Hapi's voice, meaning, language, names, [[links]], #tags, times and every fact exactly. Never add, drop or soften anything; keep list lines as lines. Also rate how stressed the writing feels (0 calm – 100 very stressed) from how it is written, and name its tone in one word.`;

export const PREFLIGHT_RULES = `Then, as a pre-flight check for a strategist who will judge this situation next: journals leave out inconvenient facts. Looking at the latest entries and "right now", is any fact missing that would change the judgement (what the other side actually said or did, Hapi's own part, what's at stake, deadlines, what Hapi really wants), or is it mostly venting? If so, ask at most 2 short, blunt, specific questions. Don't ask what was already answered. If the facts are enough, ready = true and no questions.`;

export const CALIBRATE_SYSTEM = `You keep score for Hapi's consequence engine. Compare what was predicted for a move with what really happened. Be exact and honest: give how close the prediction was (0–100), the biggest surprise, the lesson about how this person or situation really behaves (one sentence), whether the move failed at what it was for, and any behaviour pattern it showed about a person (name + pattern).`;

// ───── Answer schemas ─────

const S = { type: "string" };
const N = { type: "integer" };
const obj = (properties: Record<string, unknown>) => ({ type: "object", properties, required: Object.keys(properties) });
const arr = (items: unknown) => ({ type: "array", items });

export const STATE_SCHEMA = obj({
  goal: S,
  summary: S,
  people: arr(obj({ name: S, patterns: arr(S) })),
  leverage: S,
  blindSpots: arr(S),
  keyEvents: arr(S),
  failedMoves: arr(S),
  lessons: arr(S),
});

export const ANALYSIS_SCHEMA = obj({
  summary: S,
  stress: obj({ level: N, reading: S }),
  loops: arr(obj({ pattern: S, when: S, warning: S })),
  sunkCost: obj({ meter: N, call: { type: "string", enum: ["continue", "reassess", "walk away"] }, why: S }),
  lenses: obj({ mine: S, theirs: S, observer: S, blindSpot: S }),
  paths: arr(
    obj({
      id: { type: "string", enum: ["A", "B", "C", "D"] },
      style: { type: "string", enum: ["hold", "strategic", "direct", "exit"] },
      title: S,
      action: S,
      immediate: S,
      counter: S,
      months: S,
      longRun: S,
      risk: { type: "string", enum: ["low", "medium", "high"] },
      odds: N,
      cost: S,
    }),
  ),
  verdict: obj({ path: { type: "string", enum: ["A", "B", "C", "D"] }, text: S }),
  state: STATE_SCHEMA,
});

export const CLEAN_SCHEMA = obj({
  entries: arr(obj({ i: N, clean: S, stress: N, tone: S })),
  ready: { type: "boolean" },
  questions: arr(S),
});

export const CALIBRATE_SCHEMA = obj({
  match: N,
  surprise: S,
  lesson: S,
  failed: { type: "boolean" },
  people: arr(obj({ name: S, pattern: S })),
});

// ───── Normalising answers (models vary; nothing here may throw) ─────

const str = (v: unknown, n = 4000) => (typeof v === "string" ? v.trim().slice(0, n) : v === undefined || v === null ? "" : String(v).slice(0, n));
const num = (v: unknown, lo = 0, hi = 100) => {
  const x = Math.round(Number(v));
  return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : lo;
};
const strs = (v: unknown, max = 30) => (Array.isArray(v) ? v.map((x) => str(x, 600)).filter(Boolean).slice(0, max) : []);
const PATHS: PathId[] = ["A", "B", "C", "D"];
const STYLE: Record<PathId, string> = { A: "hold", B: "strategic", C: "direct", D: "exit" };
const TITLE: Record<PathId, string> = { A: "Hold and observe", B: "Strategic move", C: "Direct move", D: "Exit / cut losses" };

export function normalizeState(raw: unknown): SituationState {
  const o = (raw ?? {}) as Record<string, unknown>;
  const people = Array.isArray(o.people)
    ? (o.people as Record<string, unknown>[]).map((p) => ({ name: str(p?.name, 80), patterns: strs(p?.patterns, 12) })).filter((p) => p.name).slice(0, 20)
    : [];
  return {
    goal: str(o.goal, 600),
    summary: str(o.summary, 2000),
    people,
    leverage: str(o.leverage, 800),
    blindSpots: strs(o.blindSpots, 12),
    keyEvents: strs(o.keyEvents, 40),
    failedMoves: strs(o.failedMoves, 20),
    lessons: strs(o.lessons, 20),
  };
}

export function normalizeAnalysis(raw: unknown): { analysis: Analysis; state: SituationState | null } {
  const o = (raw ?? {}) as Record<string, any>;
  const list: any[] = (Array.isArray(o.paths) ? o.paths : []).slice(0, 4);
  // Valid letters first; a path without one (or with a repeated one) gets the first free letter.
  const ids: (PathId | undefined)[] = [];
  const seen = new Set<PathId>();
  list.forEach((p, i) => {
    const id = str(p?.id, 1).toUpperCase() as PathId;
    if (PATHS.includes(id) && !seen.has(id)) (ids[i] = id), seen.add(id);
  });
  list.forEach((_, i) => {
    if (ids[i]) return;
    const free = PATHS.find((x) => !seen.has(x))!;
    ids[i] = free;
    seen.add(free);
  });
  const paths: Path[] = [];
  for (const [i, p] of list.entries()) {
    const id = ids[i]!;
    const risk = str(p?.risk).toLowerCase();
    paths.push({
      id,
      style: str(p?.style, 20) || STYLE[id],
      title: str(p?.title, 120) || TITLE[id],
      action: str(p?.action, 1500),
      immediate: str(p?.immediate, 1200),
      counter: str(p?.counter, 1200),
      months: str(p?.months, 1200),
      longRun: str(p?.longRun, 1200),
      risk: risk === "low" || risk === "high" ? risk : "medium",
      odds: num(p?.odds),
      cost: str(p?.cost, 600),
    });
  }
  paths.sort((a, b) => a.id.localeCompare(b.id));
  const call = str(o.sunkCost?.call).toLowerCase();
  const verdictPath = str(o.verdict?.path, 1).toUpperCase() as PathId;
  const analysis: Analysis = {
    summary: str(o.summary, 3000),
    stress: { level: num(o.stress?.level), reading: str(o.stress?.reading, 1200) },
    loops: (Array.isArray(o.loops) ? o.loops : [])
      .map((l: any) => ({ pattern: str(l?.pattern, 600), when: str(l?.when, 200), warning: str(l?.warning, 800) }))
      .filter((l: { pattern: string; warning: string }) => l.pattern || l.warning)
      .slice(0, 6),
    sunkCost: { meter: num(o.sunkCost?.meter), call: call === "walk away" || call === "reassess" ? call : "continue", why: str(o.sunkCost?.why, 1200) },
    lenses: { mine: str(o.lenses?.mine, 2000), theirs: str(o.lenses?.theirs, 2000), observer: str(o.lenses?.observer, 2000), blindSpot: str(o.lenses?.blindSpot, 1000) },
    paths,
    verdict: { path: paths.some((p) => p.id === verdictPath) ? verdictPath : (paths[0]?.id ?? "A"), text: str(o.verdict?.text, 2000) },
  };
  return { analysis, state: o.state ? normalizeState(o.state) : null };
}

/** A JSON answer from a model that may wrap it in thinking or ``` fences. Null when there's none. */
export function looseJson(text: string): unknown {
  const t = text.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/```(?:json)?/g, "");
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(t.slice(start, end + 1));
  } catch {
    // A trailing comma is the usual slip of a local model.
    try {
      return JSON.parse(t.slice(start, end + 1).replace(/,\s*([}\]])/g, "$1"));
    } catch {
      return null;
    }
  }
}

/** The JSON shape spelled out for models without a schema option (the local model). */
export const ANALYSIS_SHAPE = `Answer with only one JSON object, no other text:
{"summary": "...", "stress": {"level": 0-100, "reading": "..."}, "loops": [{"pattern": "...", "when": "dates", "warning": "..."}],
 "sunkCost": {"meter": 0-100, "call": "continue|reassess|walk away", "why": "..."},
 "lenses": {"mine": "...", "theirs": "...", "observer": "...", "blindSpot": "..."},
 "paths": [{"id": "A|B|C|D", "style": "hold|strategic|direct|exit", "title": "...", "action": "...", "immediate": "...", "counter": "...", "months": "...", "longRun": "...", "risk": "low|medium|high", "odds": 0-100, "cost": "..."}],
 "verdict": {"path": "A|B|C|D", "text": "..."},
 "state": {"goal": "...", "summary": "...", "people": [{"name": "...", "patterns": ["..."]}], "leverage": "...", "blindSpots": ["..."], "keyEvents": ["date: ..."], "failedMoves": ["..."], "lessons": ["..."]}}`;

// ───── Calibration ─────

/** The state after an outcome was scored: the lesson, the person's pattern, a failed move remembered. */
export function calibrateState(state: SituationState | null, move: MoveRec, cal: { lesson?: string; failed?: boolean; people?: { name: string; pattern: string }[] }): SituationState {
  const s: SituationState = state
    ? { ...state, people: state.people.map((p) => ({ ...p, patterns: [...p.patterns] })), lessons: [...state.lessons], failedMoves: [...state.failedMoves] }
    : { goal: "", summary: "", people: [], leverage: "", blindSpots: [], keyEvents: [], failedMoves: [], lessons: [] };
  if (cal.lesson && !s.lessons.includes(cal.lesson)) s.lessons = [...s.lessons, `${move.day}: ${cal.lesson}`].slice(-20);
  if (cal.failed) s.failedMoves = [...s.failedMoves, `${move.day}: ${clip(move.action, 200)}`].slice(-20);
  for (const p of cal.people ?? []) {
    const name = str(p.name, 80);
    const pattern = str(p.pattern, 400);
    if (!name || !pattern) continue;
    const same = s.people.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (same) same.patterns = [...same.patterns.filter((x) => x !== pattern), pattern].slice(-12);
    else s.people.push({ name, patterns: [pattern] });
  }
  return s;
}

export function normalizeCalibration(raw: unknown): { match: number; surprise: string; lesson: string; failed: boolean; people: { name: string; pattern: string }[] } {
  const o = (raw ?? {}) as Record<string, any>;
  return {
    match: num(o.match),
    surprise: str(o.surprise, 800),
    lesson: str(o.lesson, 400),
    failed: o.failed === true,
    people: (Array.isArray(o.people) ? o.people : []).map((p: any) => ({ name: str(p?.name, 80), pattern: str(p?.pattern, 400) })).filter((p: { name: string; pattern: string }) => p.name && p.pattern).slice(0, 6),
  };
}

// ───── Note lines ─────

export const lockedLine = (title: string, action: string) => `🎲 Locked in: ${clip(action.replace(/\s+/g, " "), 400)} [[${title}]]`;
export const remindLine = (title: string, action: string) => `🎲 How did it go? ${clip(action.replace(/\s+/g, " "), 200)} [[${title}]] (log it on the page)`;
export const outcomeLine = (title: string, text: string, felt: Felt) =>
  `🎲 What happened (${felt === "better" ? "better than predicted" : felt === "worse" ? "worse than predicted" : "about as predicted"}): ${text.replace(/\s+/g, " ").trim()} [[${title}]]`;
export const nowLine = (title: string, text: string) => `🎲 [[${title}]] ${text.trim()}`;

// ───── The choice tree as a graph (Canvas and the mind map open it) ─────

export function choiceGraph(title: string, a: Analysis, when: Date): PromptMapData {
  let g = emptyGraph(`${title} · choices`);
  const added = addFeatures(g, a.paths.map((p) => `${p.id} · ${p.title}${a.verdict.path === p.id ? " ★" : ""}`));
  g = added.graph;
  a.paths.forEach((p, i) => {
    const ideas = [`Do: ${p.action}`, `Right away: ${p.immediate}`, `They react: ${p.counter}`, `3–6 months: ${p.months}`, `Long run: ${p.longRun}`, `Risk ${p.risk}, odds ${p.odds}%`].filter((x) => !/:\s*$/.test(x));
    g = addPrompt(g, { at: when, thread: `Path ${p.id}`, ideas, branchIds: ideas.map(() => added.ids[i]), sep: "\n" });
  });
  return g;
}

/** The engine's view of a situation as Markdown (for AI chat tools and Export for AI). */
export function situationMarkdown(title: string, d: EngineData): string {
  const out: string[] = [`# Consequence engine: ${title}`];
  if (d.state) {
    const s = d.state;
    out.push("", `## State (${s.at.slice(0, 10)})`, s.goal && `Goal: ${s.goal}`, s.summary, s.leverage && `Leverage: ${s.leverage}`);
    for (const p of s.people) out.push(`- ${p.name}: ${p.patterns.join("; ")}`);
    if (s.blindSpots.length) out.push(`Blind spots: ${s.blindSpots.join("; ")}`);
    if (s.lessons.length) out.push(`Lessons: ${s.lessons.join("; ")}`);
  }
  const run = d.runs[d.runs.length - 1];
  if (run) {
    const a = run.analysis;
    out.push("", `## Latest reading (${run.at.slice(0, 10)}, ${run.model})`, a.summary, `Stress ${a.stress.level}: ${a.stress.reading}`, `Sunk cost ${a.sunkCost.meter}/100 (${a.sunkCost.call}): ${a.sunkCost.why}`);
    for (const l of a.loops) out.push(`- Loop: ${l.pattern} (${l.when}) ${l.warning}`);
    out.push(`You: ${a.lenses.mine}`, `Them: ${a.lenses.theirs}`, `Observer: ${a.lenses.observer}`, `Blind spot: ${a.lenses.blindSpot}`);
    for (const p of a.paths) out.push(`- Path ${p.id} ${p.title} (risk ${p.risk}, odds ${p.odds}%): ${p.action} → ${p.immediate} → ${p.months} → ${p.longRun}`);
    out.push(`Verdict: path ${a.verdict.path}. ${a.verdict.text}`);
  }
  if (d.moves.length) {
    out.push("", "## Moves and what happened");
    for (const m of d.moves) out.push(`- ${m.day}: ${m.action} → ${m.outcome ? `${m.outcome.text} (${m.outcome.felt}${typeof m.outcome.match === "number" ? `, match ${m.outcome.match}%` : ""})` : `waiting (check ${m.checkDay})`}`);
  }
  if (d.facts.length) {
    out.push("", "## Facts given when asked");
    for (const f of d.facts) out.push(`- Q: ${f.q} A: ${f.a}`);
  }
  return out.filter((x) => x !== "").join("\n");
}
