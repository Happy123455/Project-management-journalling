// 🎲 Runs the consequence engine (the pure part is src/lib/consequence.ts): reads a situation's
// entries, cleans them and asks for missing facts (a fast model), judges it (a deep model), and
// keeps the reality loop: moves locked in, outcomes logged and scored. A reading runs outside any
// screen, so it keeps going when the page is closed; the panel only watches it.
//
// Storage: the page "Consequence engine · <title>" (state, runs, facts, moves) and
// "Consequence clean · <title>" (clean copies), both synced journal pages with events. The note
// itself is never changed by the engine; it only adds lines Hapi asked for (what's happening now,
// a locked-in move, its reminder day, the outcome), written as "me".
import type { JSONContent } from "@tiptap/react";
import type { JournalStore } from "../store";
import { askAi, localAvailable, type AiAnswer, type AiRequest } from "../ai/client";
import { coolGenerate } from "../ai/local";
import { currentJob, isMac, rest } from "../ai/chatRunner";
import { getKey } from "../ai/secrets";
import { loadAiSettings, modelFor, recordUsage } from "../ai/settings";
import { actorFor, type Provider } from "../ai/providers";
import { appendBlocks } from "../lib/append";
import { GRAPH_PREFIX, loadoutPageContent } from "../lib/canvasLoadout";
import {
  ANALYSIS_SCHEMA,
  ANALYSIS_SHAPE,
  CALIBRATE_SCHEMA,
  CALIBRATE_SYSTEM,
  CLEAN_SCHEMA,
  CLEAN_SYSTEM,
  ENGINE_SYSTEM,
  PREFLIGHT_RULES,
  calibrateState,
  choiceGraph,
  cleanPage,
  engineData,
  enginePage,
  engineRecords,
  entryKey,
  lockedLine,
  looseJson,
  newId,
  normalizeAnalysis,
  normalizeCalibration,
  nowLine,
  outcomeLine,
  parseRecords,
  recordsDoc,
  remindLine,
  situationContext,
  type CleanRec,
  type EngineData,
  type EngineRec,
  type Entry,
  type Felt,
  type MoveRec,
  type Path,
  type RunRec,
} from "../lib/consequence";
import { entryFor } from "../lib/projectDays";
import { dayKey, TIMESTAMP_RE } from "../lib/timestamp";
import { docText } from "../lib/words";
import { holdAwake } from "../lib/power";
import { showBackgroundToast } from "../lib/toast";
import { changeDay } from "../routine/routineData";

// ───── Which model ─────

export type DeepChoice = "auto" | "gemini" | "claude" | "local";
const CHOICE_KEY = "dynamic-journal.engine-model";

export function loadChoice(): DeepChoice {
  try {
    const c = localStorage.getItem(CHOICE_KEY);
    return c === "gemini" || c === "claude" || c === "local" ? c : "auto";
  } catch {
    return "auto";
  }
}
export function saveChoice(c: DeepChoice) {
  try {
    localStorage.setItem(CHOICE_KEY, c);
  } catch {
    // This session only.
  }
}

/** Characters of history each kind of model reads in one go (the local model's window is small). */
export const BUDGET: Record<Provider, number> = { gemini: 400_000, claude: 300_000, local: 20_000 };

/** The provider a reading uses: auto = Gemini when it has a key (big context), else the Mac's model, else Claude. */
export async function resolveProvider(choice: DeepChoice): Promise<Provider> {
  const settings = loadAiSettings();
  if (!settings.enabled) throw new Error("AI is turned off in Settings → AI.");
  const local = async () => isMac() && (await localAvailable());
  if (choice === "gemini" || choice === "claude") {
    if (!(await getKey(choice))) throw new Error(`Add a ${choice === "gemini" ? "Gemini" : "Claude"} key in Settings → AI first.`);
    return choice;
  }
  if (choice === "local") {
    if (await local()) return "local";
    if (await getKey("gemini")) return "gemini";
    throw new Error("The Mac's local model (Ollama) isn't running.");
  }
  if (await getKey("gemini")) return "gemini";
  if (await local()) return "local";
  if (await getKey("claude")) return "claude";
  throw new Error("This needs AI: add a Gemini key in Settings → AI (or run Ollama on the Mac).");
}

// ───── Dependencies (swapped in tests) ─────

export interface Deps {
  ask: (req: AiRequest) => Promise<AiAnswer>;
  /** The deep reading on the Mac's local model: cool bursts with rests (src/ai/local.ts). */
  local: (system: string, user: string, signal: AbortSignal, onProgress: (text: string) => void) => Promise<{ text: string; model: string }>;
  provider: (choice: DeepChoice) => Promise<Provider>;
  now: () => Date;
  /** Adds lines to the end of a day's note (through its editor when it's open). */
  appendLines: (store: JournalStore, day: string, lines: string[]) => Promise<void>;
}

async function localDeep(system: string, user: string, signal: AbortSignal, onProgress: (text: string) => void) {
  const settings = loadAiSettings();
  const model = modelFor({ ...settings, provider: "local" }, "organise");
  const out = await coolGenerate({
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    think: true,
    level: settings.cool ?? "cool",
    signal,
    rest,
    onProgress: (p) => onProgress(p.restUntil ? "resting to keep the Mac cool…" : p.answer ? `writing the answer (${p.answer.length} characters)…` : `thinking (${p.thinking.length} characters)…`),
  });
  recordUsage(model, 0, out.tokens);
  return { text: out.answer, model };
}

const para = (text: string): JSONContent => ({ type: "paragraph", content: [{ type: "text", text }] });

async function appendLines(store: JournalStore, day: string, lines: string[]) {
  const blocks = lines.map(para);
  await changeDay(
    store,
    day,
    (e) => e.chain().insertContentAt(e.state.doc.content.size, blocks).run(),
    (doc) => appendBlocks(doc, blocks),
    "me",
  );
  // Through the editor the save waits a moment: make it now, so the lines are in the journal.
  await window.__journalFlush?.();
}

export const defaultDeps: Deps = { ask: askAi, local: localDeep, provider: resolveProvider, now: () => new Date(), appendLines };

// ───── Storage ─────

const chains = new Map<string, Promise<unknown>>();
/** One write at a time per page, each reading the page fresh (no lost records). */
function serial<T>(key: string, run: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(run);
  chains.set(key, next);
  return next;
}

export async function loadEngine(store: JournalStore, title: string): Promise<EngineData> {
  const page = await store.getPage(enginePage(title));
  return engineData(parseRecords<EngineRec>(page?.content));
}

/** Changes the engine's records (`change` returns null to leave them as they are). */
export function updateEngine(store: JournalStore, title: string, change: (d: EngineData) => EngineData | null, actor = "me"): Promise<EngineData> {
  return serial(enginePage(title), async () => {
    const name = enginePage(title);
    const current = await loadEngine(store, title);
    const next = change(current);
    if (!next) return current;
    const page = await store.ensurePage(name, actor);
    const records = engineRecords(next);
    await store.savePage({ id: page.id, content: recordsDoc(records), plainText: `Consequence engine for ${title}: ${next.runs.length} readings, ${next.moves.length} moves`, actor });
    window.dispatchEvent(new CustomEvent(ENGINE_EVENT, { detail: { title } }));
    return engineData(records);
  });
}

export async function loadClean(store: JournalStore, title: string): Promise<Map<string, CleanRec>> {
  const page = await store.getPage(cleanPage(title));
  return new Map(parseRecords<CleanRec>(page?.content).filter((r) => r.kind === "clean").map((r) => [r.id, r]));
}

/** Adds clean copies; copies of entries that no longer exist (edited since) are dropped. */
export function saveClean(store: JournalStore, title: string, add: CleanRec[], keep: Set<string>, actor: string): Promise<void> {
  return serial(cleanPage(title), async () => {
    const all = await loadClean(store, title);
    for (const r of add) all.set(r.id, r);
    const records = [...all.values()].filter((r) => keep.has(r.id)).sort((a, b) => a.day.localeCompare(b.day) || a.id.localeCompare(b.id));
    const page = await store.ensurePage(cleanPage(title), actor);
    await store.savePage({ id: page.id, content: recordsDoc(records), plainText: `Clean copies for ${title}: ${records.length}`, actor });
    window.dispatchEvent(new CustomEvent(ENGINE_EVENT, { detail: { title } }));
  });
}

/** Fired when a situation's records change (the panel reloads). */
export const ENGINE_EVENT = "journal:consequence";

/** The hour an entry was written: its first timestamp in Hapi's format, or when its first line was born. */
function hourOf(lines: string[], doc: JSONContent[] | undefined): number | undefined {
  for (const line of lines) {
    const m = new RegExp(TIMESTAMP_RE.source).exec(line);
    if (m && line.slice(Math.max(0, m.index - 2), m.index) !== "✎ " && m[5] !== undefined) return Number(m[5]);
  }
  const born = (doc ?? []).map((b) => b.attrs?.born).find((b): b is string => typeof b === "string");
  if (born) {
    const d = new Date(born);
    if (!Number.isNaN(d.getTime())) return d.getHours();
  }
  return undefined;
}

/** Every day's entry about the situation (lines linking [[title]] and what's under them), oldest first. */
export async function loadEntries(store: JournalStore, title: string): Promise<Entry[]> {
  const refs = (await store.references("wikilink", title)).filter((r) => r.day);
  const out: Entry[] = [];
  for (const r of refs) {
    const e = entryFor(r.day!, r.content as never, title);
    if (!e) continue;
    const raw = e.lines.join("\n").trim();
    if (raw) out.push({ day: e.day, raw, key: entryKey(e.day, raw), hour: hourOf(e.lines, e.doc) });
  }
  return out.sort((a, b) => a.day.localeCompare(b.day));
}

// ───── Readings: the job ─────

export type Phase = "saving" | "cleaning" | "asking" | "thinking" | "done" | "error";
export interface JobState {
  title: string;
  phase: Phase;
  /** What's happening, in words. */
  step: string;
  questions?: string[];
  error?: string;
  provider?: Provider;
  startedAt: number;
}

const jobs = new Map<string, JobState>();
/** Each reading's number: an answer from a stopped or replaced reading is dropped. */
const generation = new Map<string, number>();
const live = (title: string, gen: number) => jobs.has(title) && generation.get(title) === gen;
const stoppers = new Map<string, AbortController>();
const waiting = new Map<string, { provider: Provider; page: string; now: string; gen: number }>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
export const jobFor = (title: string) => jobs.get(title) ?? null;
export function subscribeJobs(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
const set = (title: string, patch: Partial<JobState>) => {
  const prev = jobs.get(title);
  jobs.set(title, { title, phase: "saving", step: "", startedAt: Date.now(), ...prev, ...patch });
  emit();
};
export const busy = (title: string) => {
  const p = jobs.get(title)?.phase;
  return p === "saving" || p === "cleaning" || p === "thinking";
};
/** Closes a finished or failed reading's status line. */
export function clearJob(title: string) {
  if (busy(title)) return;
  jobs.delete(title);
  waiting.delete(title);
  emit();
}
/** Stops a reading (the local model stops at once; a cloud answer still on its way is ignored). */
export function stopReading(title: string) {
  stoppers.get(title)?.abort();
  stoppers.delete(title);
  waiting.delete(title);
  jobs.delete(title);
  emit();
}

/**
 * A JSON answer: with the schema, or, if the provider turns the schema down (a 400 about it), once
 * more without it, the shape spelled out in the request instead.
 */
async function askJson(deps: Deps, req: AiRequest, shape: string): Promise<{ json: unknown; actor: string; model: string }> {
  try {
    const a = await deps.ask(req);
    return { json: a.json ?? looseJson(a.text), actor: a.actor, model: a.model };
  } catch (e) {
    if (!/schema|invalid json payload|unknown name|400/i.test(errText(e))) throw e;
    const a = await deps.ask({ ...req, schema: undefined, text: `${req.text}\n\n${shape}` });
    return { json: looseJson(a.text), actor: a.actor, model: a.model };
  }
}

const CLEAN_SHAPE = 'Answer with only one JSON object: {"entries": [{"i": 0, "clean": "...", "stress": 0-100, "tone": "one word"}], "ready": true|false, "questions": ["..."]}';
const CALIBRATE_SHAPE = 'Answer with only one JSON object: {"match": 0-100, "surprise": "...", "lesson": "...", "failed": true|false, "people": [{"name": "...", "pattern": "..."}]}';

const fastTask = (p: Provider) => (p === "local" ? "describe" : "grammar");
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Clean copies for up to `max` entries without one (newest first), plus the pre-flight questions. */
async function cleanAndAsk(store: JournalStore, title: string, provider: Provider, entries: Entry[], now: string, ask: boolean, deps: Deps, max = 12): Promise<{ questions: string[]; cleaned: number; actor: string }> {
  const have = await loadClean(store, title);
  const todo = entries.filter((e) => !have.has(e.key)).slice(-max);
  // Keep a batch to a size a fast model answers in one go.
  let room = 14_000;
  const batch: Entry[] = [];
  for (const e of [...todo].reverse()) {
    if (batch.length && room - e.raw.length < 0) break;
    batch.unshift(e);
    room -= Math.min(e.raw.length, 6000);
  }
  if (!batch.length && !ask) return { questions: [], cleaned: 0, actor: "" };
  const data = await loadEngine(store, title);
  const latest = entries.slice(-3);
  const text = [
    `Situation: ${title}`,
    batch.length ? `\nCLEAN these entries:\n${batch.map((e, i) => `[${i}] ${e.day}\n${e.raw.slice(0, 6000)}`).join("\n\n")}` : "\nCLEAN: (no entries to clean; answer entries: [])",
    ask ? `\nLatest entries:\n${latest.map((e) => `${e.day}: ${e.raw.slice(0, 3000)}`).join("\n\n") || "(none)"}` : "",
    ask && now ? `\nRight now: ${now}` : "",
    ask && data.facts.length ? `\nAlready asked and answered:\n${data.facts.slice(-10).map((f) => `- ${f.q} → ${f.a.slice(0, 300)}`).join("\n")}` : "",
    ask && data.state?.summary ? `\nWhat's known so far: ${data.state.summary.slice(0, 1500)}` : "",
    ask ? "" : "\n(No pre-flight check this time: ready = true, questions = [].)",
  ].join("\n");
  const a = await askJson(
    deps,
    { task: fastTask(provider), provider, system: `${CLEAN_SYSTEM}\n\n${PREFLIGHT_RULES}`, text, schema: CLEAN_SCHEMA, maxTokens: 8192, timeoutMs: provider === "local" ? 300_000 : 120_000 },
    CLEAN_SHAPE,
  );
  const json = (a.json ?? {}) as { entries?: { i?: number; clean?: string; stress?: number; tone?: string }[]; ready?: boolean; questions?: unknown[] };
  const add: CleanRec[] = [];
  for (const c of json.entries ?? []) {
    const e = batch[Number(c?.i)];
    const clean = typeof c?.clean === "string" ? c.clean.trim() : "";
    if (!e || !clean) continue;
    add.push({ kind: "clean", id: e.key, day: e.day, clean: clean.slice(0, 20_000), ...(Number.isFinite(Number(c.stress)) ? { stress: Math.max(0, Math.min(100, Math.round(Number(c.stress)))) } : {}), ...(c.tone ? { tone: String(c.tone).slice(0, 24) } : {}), by: a.actor });
  }
  if (add.length) await saveClean(store, title, add, new Set(entries.map((e) => e.key)), a.actor);
  const questions = ask && json.ready !== true ? (json.questions ?? []).map((q) => String(q ?? "").trim()).filter(Boolean).slice(0, 2) : [];
  return { questions, cleaned: add.length, actor: a.actor };
}

/**
 * 🎲 Reads the situation: saves "right now" to today's note, cleans the newest entries and checks
 * for missing facts (questions stop here until answered or skipped), then the deep reading.
 */
export async function startReading(store: JournalStore, title: string, o: { pageText: string; now?: string; choice: DeepChoice }, deps: Deps = defaultDeps): Promise<boolean> {
  if (busy(title)) return false;
  let saved = false;
  const gen = (generation.get(title) ?? 0) + 1;
  generation.set(title, gen);
  jobs.delete(title);
  set(title, { phase: "saving", step: "Getting the entries…", startedAt: Date.now(), error: undefined, questions: undefined });
  const release = holdAwake();
  try {
    const now = (o.now ?? "").trim();
    await window.__journalFlush?.();
    // Hapi's words go into the journal first, before anything that could fail.
    if (now) await deps.appendLines(store, dayKey(deps.now()), [nowLine(title, now)]);
    saved = !!now;
    const provider = await deps.provider(o.choice);
    if (provider === "local" && currentJob()) throw new Error("The Mac's model is answering an AI chat; try again when it's done (or pick Gemini).");
    const entries = await loadEntries(store, title);
    if (!entries.length && !now) throw new Error(`Nothing to read yet: write about it in a note with [[${title}]], or type what's happening in the box.`);
    set(title, { phase: "cleaning", step: "Cleaning the newest entries and checking the facts…", provider });
    let questions: string[] = [];
    try {
      questions = (await cleanAndAsk(store, title, provider, entries, now, true, deps)).questions;
    } catch (e) {
      // Not needed for the reading itself: go on without clean copies or questions.
      showBackgroundToast(`🎲 Skipped the clean-up: ${errText(e)}`, "error");
    }
    if (!live(title, gen)) return saved;
    if (questions.length) {
      waiting.set(title, { provider, page: o.pageText, now, gen });
      set(title, { phase: "asking", step: "A couple of facts first", questions });
      return saved;
    }
    await deep(store, title, provider, o.pageText, now, deps, gen);
  } catch (e) {
    if (live(title, gen)) set(title, { phase: "error", step: "", error: errText(e) });
  } finally {
    release();
  }
  return saved;
}

/** The answers to the pre-flight questions (null: skip them and read anyway), then the deep reading. */
export async function answerQuestions(store: JournalStore, title: string, answers: string[] | null, deps: Deps = defaultDeps): Promise<void> {
  const job = jobs.get(title);
  const w = waiting.get(title);
  if (!job || job.phase !== "asking" || !w) return;
  waiting.delete(title);
  const release = holdAwake();
  try {
    const qs = job.questions ?? [];
    const facts = (answers ?? []).map((a, i) => ({ q: qs[i] ?? "", a: a.trim() })).filter((f) => f.q && f.a);
    set(title, { phase: "saving", step: "Saving your answers…", questions: undefined });
    if (facts.length) {
      const at = deps.now().toISOString();
      await updateEngine(store, title, (d) => ({ ...d, facts: [...d.facts, ...facts.map((f) => ({ kind: "fact" as const, id: newId(), at, ...f }))] }), "me");
    }
    await deep(store, title, w.provider, w.page, w.now, deps, w.gen);
  } catch (e) {
    if (live(title, w.gen)) set(title, { phase: "error", step: "", error: errText(e) });
  } finally {
    release();
  }
}

async function deep(store: JournalStore, title: string, provider: Provider, pageText: string, now: string, deps: Deps, gen: number) {
  const entries = await loadEntries(store, title);
  const [clean, data] = await Promise.all([loadClean(store, title), loadEngine(store, title)]);
  const today = dayKey(deps.now());
  const context = situationContext({ title, today, page: pageText, entries, clean, data, now, budget: BUDGET[provider] });
  const ask = `${context}\n\nRead this situation as the Consequence Engine and answer in the JSON asked for.`;
  let raw: unknown;
  let actor: string;
  let model: string;
  if (provider === "local") {
    set(title, { phase: "thinking", step: "The Mac's model is thinking (cool bursts; this takes a few minutes)…", provider });
    const stop = new AbortController();
    stoppers.set(title, stop);
    const r = await deps.local(ENGINE_SYSTEM, `${ask}\n\n${ANALYSIS_SHAPE}`, stop.signal, (p) => live(title, gen) && set(title, { step: `The Mac's model is ${p}` }));
    stoppers.delete(title);
    raw = looseJson(r.text);
    if (!raw) throw new Error("The local model's answer wasn't readable. Try again, or pick Gemini.");
    model = r.model;
    actor = actorFor("local", r.model);
  } else {
    set(title, { phase: "thinking", step: `Reading ${entries.length} entries with ${provider === "gemini" ? "Gemini" : "Claude"} (up to a few minutes)…`, provider });
    const a = await askJson(deps, { task: "organise", provider, system: ENGINE_SYSTEM, text: ask, schema: ANALYSIS_SCHEMA, maxTokens: 12_000, timeoutMs: 240_000 }, ANALYSIS_SHAPE);
    raw = a.json;
    model = a.model;
    actor = a.actor;
  }
  if (!live(title, gen)) return;
  const { analysis, state } = normalizeAnalysis(raw);
  if (!analysis.paths.length || !analysis.summary) throw new Error("The answer came back without a reading. Try again.");
  const at = deps.now().toISOString();
  const run: RunRec = { kind: "run", id: newId(), at, by: actor, model, entries: entries.length, analysis };
  await updateEngine(store, title, (d) => ({ ...d, runs: [...d.runs, run], state: state ? { kind: "state", id: "state", at, ...state } : d.state }), actor);
  if (live(title, gen)) set(title, { phase: "done", step: "", questions: undefined });
  showBackgroundToast(`🎲 ${title}: read. Verdict: path ${analysis.verdict.path}`, "info");
}

/** ✨ Clean copies for every entry that has none, in batches (for reading; the notes stay as written). */
export async function cleanAll(store: JournalStore, title: string, choice: DeepChoice, deps: Deps = defaultDeps): Promise<void> {
  if (busy(title)) return;
  const gen = (generation.get(title) ?? 0) + 1;
  generation.set(title, gen);
  jobs.delete(title);
  set(title, { phase: "cleaning", step: "Cleaning…", startedAt: Date.now() });
  const release = holdAwake();
  try {
    await window.__journalFlush?.();
    const provider = await deps.provider(choice);
    const entries = await loadEntries(store, title);
    for (let round = 0; round < 60 && live(title, gen); round++) {
      const have = await loadClean(store, title);
      const left = entries.filter((e) => !have.has(e.key)).length;
      if (!left) break;
      set(title, { step: `Cleaning entries: ${entries.length - left} of ${entries.length} done…`, provider });
      const r = await cleanAndAsk(store, title, provider, entries, "", false, deps, 10);
      if (!r.cleaned) throw new Error("The model didn't return clean copies. Try again later.");
    }
    if (live(title, gen)) {
      jobs.delete(title);
      emit();
    }
  } catch (e) {
    if (live(title, gen)) set(title, { phase: "error", step: "", error: errText(e) });
  } finally {
    release();
  }
}

// ───── The reality loop ─────

/** 🔒 Lock in a move: saved, written in today's note, and (optionally) a reminder on the check day. */
export async function lockIn(
  store: JournalStore,
  title: string,
  m: { run?: RunRec; path?: Path; action: string; checkDay: string; remind: boolean },
  deps: Deps = defaultDeps,
): Promise<MoveRec> {
  const at = deps.now();
  const move: MoveRec = {
    kind: "move",
    id: newId(),
    at: at.toISOString(),
    day: dayKey(at),
    ...(m.run ? { runId: m.run.id } : {}),
    path: m.path?.id ?? "custom",
    action: m.action.trim(),
    predicted: m.path ? { immediate: m.path.immediate, months: m.path.months, odds: m.path.odds, risk: m.path.risk } : { immediate: "", months: "" },
    checkDay: m.checkDay,
  };
  await updateEngine(store, title, (d) => ({ ...d, moves: [...d.moves, move] }), "me");
  await deps.appendLines(store, move.day, [lockedLine(title, move.action)]);
  if (m.remind && m.checkDay > move.day) await deps.appendLines(store, m.checkDay, [remindLine(title, move.action)]);
  return move;
}

/**
 * 📝 What really happened: saved at once (and written in today's note), then scored against the
 * prediction in the background; the lesson and the person's pattern go into the rolling state.
 */
export async function logOutcome(store: JournalStore, title: string, moveId: string, o: { text: string; felt: Felt; choice: DeepChoice }, deps: Deps = defaultDeps): Promise<void> {
  const text = o.text.trim();
  if (!text) return;
  const at = deps.now();
  let move: MoveRec | undefined;
  await updateEngine(store, title, (d) => {
    move = d.moves.find((x) => x.id === moveId);
    if (!move) return null;
    move = { ...move, outcome: { at: at.toISOString(), text, felt: o.felt } };
    return { ...d, moves: d.moves.map((x) => (x.id === moveId ? move! : x)) };
  }, "me");
  if (!move) throw new Error("That move isn't there any more.");
  await deps.appendLines(store, dayKey(at), [outcomeLine(title, text, o.felt)]);
  try {
    const provider = await deps.provider(o.choice);
    const state = (await loadEngine(store, title)).state;
    const m = move;
    const a = await askJson(deps, {
      task: fastTask(provider),
      provider,
      system: CALIBRATE_SYSTEM,
      text: [
        `Situation: ${title}`,
        `Move (${m.day}, ${m.path === "custom" ? "Hapi's own move" : `path ${m.path}`}): ${m.action}`,
        `Predicted right away: ${m.predicted.immediate || "(no prediction)"}`,
        `Predicted in 3–6 months: ${m.predicted.months || "(no prediction)"}${m.predicted.odds !== undefined ? ` (odds ${m.predicted.odds}%)` : ""}`,
        `What really happened (${text.length > 0 ? at.toISOString().slice(0, 10) : ""}): ${text}`,
        `Hapi felt it went ${o.felt === "better" ? "better than predicted" : o.felt === "worse" ? "worse than predicted" : "about as predicted"}.`,
        state?.people.length ? `People known so far: ${state.people.map((p) => `${p.name} (${p.patterns.slice(-3).join("; ")})`).join(", ")}` : "",
      ].join("\n"),
      schema: CALIBRATE_SCHEMA,
      maxTokens: 2048,
      timeoutMs: provider === "local" ? 300_000 : 60_000,
    }, CALIBRATE_SHAPE);
    const cal = normalizeCalibration(a.json);
    await updateEngine(
      store,
      title,
      (d) => {
        const cur = d.moves.find((x) => x.id === moveId);
        if (!cur?.outcome) return null;
        const scored: MoveRec = { ...cur, outcome: { ...cur.outcome, match: cal.match, surprise: cal.surprise, lesson: cal.lesson, failed: cal.failed, by: a.actor } };
        const s = calibrateState(d.state, scored, cal);
        return { ...d, moves: d.moves.map((x) => (x.id === moveId ? scored : x)), state: { kind: "state", id: "state", at: at.toISOString(), ...s } };
      },
      a.actor,
    );
  } catch (e) {
    showBackgroundToast(`🎲 Saved what happened; scoring it didn't work: ${errText(e)}`, "error");
  }
}

/** Removes a move Hapi locked in by mistake (the lines in the notes stay; they're Hapi's to edit). */
export function removeMove(store: JournalStore, title: string, moveId: string): Promise<EngineData> {
  return updateEngine(store, title, (d) => (d.moves.some((m) => m.id === moveId) ? { ...d, moves: d.moves.filter((m) => m.id !== moveId) } : null), "me");
}

/** 🧩 The choice tree as a graph Canvas and the mind map open ("Graph · <title> choices"). */
export async function saveChoiceGraph(store: JournalStore, title: string, run: RunRec): Promise<string> {
  const name = `${GRAPH_PREFIX}${title} choices`;
  const graph = choiceGraph(title, run.analysis, new Date(run.at));
  const page = await store.ensurePage(name, run.by);
  await store.savePage({ id: page.id, content: loadoutPageContent(graph), plainText: `Graph: ${title} choices (${graph.segs.length} nodes)`, actor: run.by });
  return name;
}

/** The text of a page, for the reading (its own notes about the situation). */
export const pageTextOf = (content: JSONContent | null | undefined) => (content ? docText(content) : "");
