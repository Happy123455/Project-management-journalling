// 🛢️ Runs the evening oil-drop check (the pure part is src/lib/oilDrop.ts). One check per day,
// kept on the synced page "Oil drops" (one record per day). It runs by itself once the evening hour
// has come (or the next morning if the evening was missed) while the app is open: one request, no
// polling, a single timer to the hour while the app is on screen. The note itself is only added to
// when a drill ends (the whys and the root cause) or Hapi asks for the fix as a reminder.
import type { JSONContent } from "@tiptap/react";
import type { JournalStore } from "../store";
import { askAi, type AiAnswer, type AiRequest } from "../ai/client";
import { loadAiSettings } from "../ai/settings";
import type { Provider } from "../ai/providers";
import { askJson, errText, resolveProvider } from "../consequence/engine";
import { appendBlocks } from "../lib/append";
import { parseRecords, recordsDoc } from "../lib/consequence";
import {
  CHECK_SCHEMA,
  CHECK_SHAPE,
  CHECK_SYSTEM,
  DRILL_SCHEMA,
  DRILL_SHAPE,
  DRILL_SYSTEM,
  DROPS_PAGE,
  MAX_WHYS,
  checkContext,
  drillText,
  dueDay,
  fixLine,
  nextDay,
  normalizeDrill,
  normalizeDrop,
  prevDay,
  rootLines,
  untilHour,
  type DayText,
  type DropRec,
} from "../lib/oilDrop";
import { dayKey } from "../lib/timestamp";
import { docText } from "../lib/words";
import { holdAwake } from "../lib/power";
import { showBackgroundToast } from "../lib/toast";
import { changeDay } from "../routine/routineData";

/** Characters of notes each kind of model reads (the local model's window is small). */
const BUDGET: Record<Provider, number> = { gemini: 60_000, claude: 60_000, local: 16_000 };

export interface Deps {
  ask: (req: AiRequest) => Promise<AiAnswer>;
  provider: () => Promise<Provider>;
  now: () => Date;
  /** Adds lines to the end of a day's note (through its editor when it's open). */
  appendLines: (store: JournalStore, day: string, lines: string[], actor: string) => Promise<void>;
}

const para = (text: string): JSONContent => ({ type: "paragraph", content: [{ type: "text", text }] });

async function appendLines(store: JournalStore, day: string, lines: string[], actor: string) {
  const blocks = lines.map(para);
  await changeDay(
    store,
    day,
    // An AI's lines carry its name, so they show (and can be undone) in Settings → AI changes.
    (e) => e.chain().command(({ tr }) => (actor !== "me" && tr.setMeta("aiActor", actor), true)).insertContentAt(e.state.doc.content.size, blocks).run(),
    (doc) => appendBlocks(doc, blocks),
    actor,
  );
  await window.__journalFlush?.();
}

export const defaultDeps: Deps = { ask: askAi, provider: () => resolveProvider("auto"), now: () => new Date(), appendLines };

// ───── Storage ─────

export const DROPS_EVENT = "journal:oil-drops";
let chain: Promise<unknown> = Promise.resolve();
let cache: DropRec[] | null = null;

export async function loadDrops(store: JournalStore): Promise<DropRec[]> {
  if (cache) return cache;
  const page = await store.getPage(DROPS_PAGE);
  cache = parseRecords<DropRec>(page?.content).filter((r) => r.kind === "drop");
  return cache;
}
/** Sync brought something new: read the page again next time. */
export function forgetDrops() {
  cache = null;
}

/** Changes one day's record (`change` returns null to leave it), one write at a time. */
export function updateDrop(store: JournalStore, day: string, change: (r: DropRec | undefined) => DropRec | null, actor: string): Promise<DropRec | undefined> {
  const next = chain.catch(() => {}).then(async () => {
    cache = null;
    const all = await loadDrops(store);
    const cur = all.find((r) => r.id === day);
    const rec = change(cur);
    if (!rec) return cur;
    const records = [...all.filter((r) => r.id !== day), rec].sort((a, b) => a.day.localeCompare(b.day));
    const page = await store.ensurePage(DROPS_PAGE, actor);
    await store.savePage({ id: page.id, content: recordsDoc(records), plainText: `Oil-drop checks: ${records.length} days, ${records.filter((r) => r.drop.found).length} drops`, actor });
    cache = records;
    window.dispatchEvent(new CustomEvent(DROPS_EVENT, { detail: { day } }));
    return rec;
  });
  chain = next;
  return next;
}

// ───── Jobs (watched by the card) ─────

export interface DropJob {
  day: string;
  step: string;
  error?: string;
}
const jobs = new Map<string, DropJob>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
export const dropJob = (day: string) => jobs.get(day) ?? null;
export function subscribeDropJobs(l: () => void) {
  listeners.add(l);
  return () => void listeners.delete(l);
}
const setJob = (day: string, j: DropJob | null) => {
  if (j) jobs.set(day, j);
  else jobs.delete(day);
  emit();
};
export const clearDropError = (day: string) => jobs.get(day)?.error && setJob(day, null);

async function dayTexts(store: JournalStore, day: string): Promise<DayText[]> {
  const days: string[] = [day];
  for (let i = 0; i < 6; i++) days.push(prevDay(days[days.length - 1]));
  const pages = await Promise.all(days.map((d) => store.getDay(d)));
  return days.map((d, i) => ({ day: d, text: pages[i] ? docText(pages[i]!.content) : "" }));
}

/** 🛢️ Checks a day. Resolves with the record (or null when it failed; the error shows on the card). */
export async function runCheck(store: JournalStore, day: string, o: { auto?: boolean } = {}, deps: Deps = defaultDeps): Promise<DropRec | null> {
  if (jobs.get(day) && !jobs.get(day)!.error) return null;
  setJob(day, { day, step: "Reading the week…" });
  const release = holdAwake();
  try {
    await window.__journalFlush?.();
    const provider = await deps.provider();
    const [days, records] = await Promise.all([dayTexts(store, day), loadDrops(store)]);
    const { text, read } = checkContext({ day, days, records, budget: BUDGET[provider] });
    if (read < 20) throw new Error("Nothing written on this day yet.");
    setJob(day, { day, step: provider === "local" ? "The Mac's model is reading the week…" : "Looking for an oil drop…" });
    const a = await askJson(
      deps,
      { task: provider === "local" ? "describe" : "grammar", provider, system: CHECK_SYSTEM, text, schema: CHECK_SCHEMA, maxTokens: 2048, timeoutMs: provider === "local" ? 300_000 : 90_000 },
      CHECK_SHAPE,
    );
    const drop = normalizeDrop(a.json);
    const rec: DropRec = { kind: "drop", id: day, day, at: deps.now().toISOString(), by: a.actor, model: a.model, ...(o.auto ? { auto: true } : {}), read, drop, whys: [] };
    // A new check replaces the day's earlier one (only its drill, if one was going, is lost).
    await updateDrop(store, day, () => rec, a.actor);
    setJob(day, null);
    return rec;
  } catch (e) {
    setJob(day, { day, step: "", error: errText(e) });
    return null;
  } finally {
    release();
  }
}

/** The question waiting for Hapi's answer, or "" when the drill is over (or there's none). */
export const openQuestion = (r: DropRec): string => (!r.drop.found || r.final || r.dismissed ? "" : r.whys.length ? r.next ?? "" : r.drop.why);

/**
 * Hapi's answer to the open "Why?" (saved at once), then the next why, or the root cause (written in
 * the day's note). `stop` sums up with the answers so far.
 */
export async function answerWhy(store: JournalStore, day: string, answer: string, o: { stop?: boolean } = {}, deps: Deps = defaultDeps): Promise<void> {
  const a = answer.trim();
  let rec: DropRec | undefined;
  if (a) {
    rec = await updateDrop(
      store,
      day,
      (r) => {
        const q = r && openQuestion(r);
        if (!r || !q) return null;
        return { ...r, whys: [...r.whys, { q, a, at: deps.now().toISOString() }], next: "" };
      },
      "me",
    );
  } else rec = (await loadDrops(store)).find((r) => r.id === day);
  if (!rec || rec.final || !rec.whys.length) return;
  setJob(day, { day, step: "Thinking about why…" });
  const release = holdAwake();
  try {
    const provider = await deps.provider();
    const force = !!o.stop || rec.whys.length >= MAX_WHYS;
    const r = await askJson(
      deps,
      { task: provider === "local" ? "describe" : "grammar", provider, system: DRILL_SYSTEM, text: drillText(rec, force), schema: DRILL_SCHEMA, maxTokens: 1024, timeoutMs: provider === "local" ? 180_000 : 60_000 },
      DRILL_SHAPE,
    );
    const d = normalizeDrill(r.json, force);
    if (!d.done && !d.question) throw new Error("The answer came back empty. Try again.");
    const at = deps.now().toISOString();
    const saved = await updateDrop(store, day, (cur) => (cur && !cur.final ? { ...cur, ...(d.done ? { final: { root: d.root, risk: d.risk, fix: d.fix, at, by: r.actor }, next: "" } : { next: d.question }) } : null), r.actor);
    if (d.done && saved?.final) await deps.appendLines(store, day, rootLines(saved), r.actor);
    setJob(day, null);
  } catch (e) {
    setJob(day, { day, step: "", error: errText(e) });
  } finally {
    release();
  }
}

/** "Not a real problem": kept, so later checks don't raise it again unless it gets worse. */
export function dismissDrop(store: JournalStore, day: string, dismissed = true) {
  return updateDrop(store, day, (r) => (r ? { ...r, dismissed } : null), "me");
}

/** ⏰ The fix as a reminder on the next day (today, when the check was for an earlier day). */
export async function remindFix(store: JournalStore, day: string, deps: Deps = defaultDeps): Promise<string | null> {
  const r = (await loadDrops(store)).find((x) => x.id === day);
  const fix = r?.final?.fix || r?.drop.fix;
  if (!r || !fix) return null;
  const today = dayKey(deps.now());
  const on = nextDay(day) > today ? nextDay(day) : today;
  await deps.appendLines(store, on, [fixLine(fix)], "me");
  await updateDrop(store, day, (cur) => (cur ? { ...cur, fixDay: on } : null), "me");
  return on;
}

// ───── The evening timer ─────

const TRIES_KEY = "dynamic-journal.oil-drop-tries";
function tries(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(TRIES_KEY) ?? "{}");
  } catch {
    return {};
  }
}
function addTry(day: string) {
  const t = tries();
  // Only the last few days matter.
  const keep = Object.fromEntries(Object.entries(t).sort().slice(-5));
  keep[day] = (keep[day] ?? 0) + 1;
  try {
    localStorage.setItem(TRIES_KEY, JSON.stringify(keep));
  } catch {
    // Not remembered: at most one more try.
  }
}

export const eveningOn = () => {
  const s = loadAiSettings();
  return s.enabled && s.oilDrop !== false;
};
export const eveningHour = () => loadAiSettings().oilDropHour ?? 21;

let running = false;
/** Runs the check if one is due now. */
export async function maybeRunEvening(store: JournalStore, deps: Deps = defaultDeps): Promise<DropRec | null> {
  if (running || !eveningOn()) return null;
  running = true;
  try {
    const now = deps.now();
    const today = dayKey(now);
    const records = await loadDrops(store);
    const chars = new Map<string, number>();
    for (const d of [today, prevDay(today)]) {
      const p = await store.getDay(d);
      chars.set(d, p ? docText(p.content).length : 0);
    }
    const t = tries();
    const day = dueDay({ now, hour: eveningHour(), today, has: (d) => records.some((r) => r.id === d), chars: (d) => chars.get(d) ?? 0, tries: (d) => t[d] ?? 0 });
    if (!day) return null;
    addTry(day);
    const rec = await runCheck(store, day, { auto: true }, deps);
    if (rec?.drop.found)
      showBackgroundToast(`🛢️ ${day === today ? "Tonight's" : "Yesterday's"} check found something: ${rec.drop.symptom}`, "info", {
        label: "Open",
        run: () => window.dispatchEvent(new CustomEvent("journal:open-day", { detail: day })),
      });
    return rec;
  } catch {
    return null;
  } finally {
    running = false;
  }
}

/** Starts the evening check: on opening, on coming back to the app, and at the hour while open. */
export function startEveningCheck(store: JournalStore): () => void {
  let soon: number | undefined;
  let atHour: number | undefined;
  const plan = () => {
    window.clearTimeout(soon);
    window.clearTimeout(atHour);
    if (document.visibilityState !== "visible" || !eveningOn()) return;
    // A little after opening, so starting the app stays quick (yesterday may still be due, or tonight's).
    soon = window.setTimeout(() => void maybeRunEvening(store), 20_000);
    const ms = untilHour(new Date(), eveningHour());
    if (ms !== null) atHour = window.setTimeout(() => void maybeRunEvening(store), ms + 5_000);
  };
  document.addEventListener("visibilitychange", plan);
  window.addEventListener("journal:ai-settings", plan);
  plan();
  return () => {
    window.clearTimeout(soon);
    window.clearTimeout(atHour);
    document.removeEventListener("visibilitychange", plan);
    window.removeEventListener("journal:ai-settings", plan);
  };
}
