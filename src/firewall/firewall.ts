// 🧯 Runs the rhetoric firewall (the pure part is src/lib/firewall.ts). One check at a time, kept
// outside any screen so closing the panel doesn't stop it. Sources: a YouTube link (Gemini watches
// the video itself, no transcript needed), a web link (its readable text), pasted words, or live
// listening (the 🎙️ voice pipeline: words transcribed as they're heard, audited piece by piece,
// summed up at the end). Checks are kept on the synced page "Rhetoric firewall"; nothing is written
// in the notes unless Hapi taps ＋ Today.
import type { JSONContent } from "@tiptap/react";
import type { JournalStore } from "../store";
import { askAi, type AiAnswer, type AiRequest } from "../ai/client";
import type { Provider } from "../ai/providers";
import { startLive, type LiveRecording } from "../ai/voice";
import { recordingVoice } from "../ai/voiceSession";
import { askJson, errText, resolveProvider, type DeepChoice } from "../consequence/engine";
import { appendBlocks } from "../lib/append";
import { newId, parseRecords, recordsDoc } from "../lib/consequence";
import {
  CHECK_SCHEMA,
  CHECK_SHAPE,
  CHUNK_SCHEMA,
  CHUNK_SHAPE,
  FIREWALL_PAGE,
  FIREWALL_SYSTEM,
  KEEP_CHECKS,
  LIVE_SYSTEM,
  SUM_SCHEMA,
  SUM_SHAPE,
  SUM_SYSTEM,
  checkRequest,
  chunkRequest,
  knownSpeaker,
  normalizeCheck,
  normalizeClaims,
  normalizeSummary,
  pageText,
  priorPremises,
  todayLines,
  watchUrl,
  type CheckRec,
  type Claim,
  type SourceInfo,
} from "../lib/firewall";
import { youtubeId } from "../lib/linkPreview";
import { dayKey } from "../lib/timestamp";
import { holdAwake } from "../lib/power";
import { showBackgroundToast } from "../lib/toast";
import { changeDay } from "../routine/routineData";

/** Characters of text each kind of model reads in one check. */
const BUDGET: Record<Provider, number> = { gemini: 300_000, claude: 200_000, local: 18_000 };
/** Live listening: new words are audited once about this many characters have come in (≈ 40 s of talk). */
export const LIVE_PIECE = 650;

export interface Deps {
  ask: (req: AiRequest) => Promise<AiAnswer>;
  provider: (choice: DeepChoice) => Promise<Provider>;
  now: () => Date;
  /** A web page's HTML (through the app's own HTTP: pages don't allow reading from a web view). */
  fetchHtml: (url: string) => Promise<string>;
  /** A YouTube video's title and channel (oEmbed). */
  meta: (url: string) => Promise<{ title: string | null; site: string | null } | null>;
  listen: typeof startLive;
  appendLines: (store: JournalStore, day: string, lines: string[], actor: string) => Promise<void>;
}

const para = (text: string): JSONContent => ({ type: "paragraph", content: [{ type: "text", text }] });

async function fetchHtml(url: string): Promise<string> {
  const get = "__TAURI_INTERNALS__" in window ? (await import("@tauri-apps/plugin-http")).fetch : fetch;
  const res = await get(url, { signal: AbortSignal.timeout(20_000), headers: { Accept: "text/html" } });
  if (!res.ok) throw new Error(`The page answered ${res.status}.`);
  return await res.text();
}

export const defaultDeps: Deps = {
  ask: askAi,
  provider: resolveProvider,
  now: () => new Date(),
  fetchHtml,
  meta: async (url) => (await import("../editor/linkCard")).fetchMeta(url),
  listen: startLive,
  appendLines: async (store, day, lines, actor) => {
    const blocks = lines.map(para);
    await changeDay(
      store,
      day,
      (e) => e.chain().command(({ tr }) => (actor !== "me" && tr.setMeta("aiActor", actor), true)).insertContentAt(e.state.doc.content.size, blocks).run(),
      (doc) => appendBlocks(doc, blocks),
      actor,
    );
    await window.__journalFlush?.();
  },
};

// ───── Storage ─────

export const FIREWALL_EVENT = "journal:firewall";
let chain: Promise<unknown> = Promise.resolve();

export async function loadChecks(store: JournalStore): Promise<CheckRec[]> {
  const page = await store.getPage(FIREWALL_PAGE);
  return parseRecords<CheckRec>(page?.content)
    .filter((r) => r.kind === "check")
    .sort((a, b) => a.at.localeCompare(b.at));
}

/** Adds or changes one check (`change` returns null to leave it). The oldest go past KEEP_CHECKS. */
export function updateCheck(store: JournalStore, id: string, change: (r: CheckRec | undefined) => CheckRec | null, actor: string): Promise<CheckRec | undefined> {
  const next = chain.catch(() => {}).then(async () => {
    const all = await loadChecks(store);
    const cur = all.find((r) => r.id === id);
    const rec = change(cur);
    if (!rec) return cur;
    const records = [...all.filter((r) => r.id !== id), rec].sort((a, b) => a.at.localeCompare(b.at)).slice(-KEEP_CHECKS);
    const page = await store.ensurePage(FIREWALL_PAGE, actor);
    await store.savePage({ id: page.id, content: recordsDoc(records), plainText: `Rhetoric firewall: ${records.length} checks`, actor });
    window.dispatchEvent(new CustomEvent(FIREWALL_EVENT, { detail: { id } }));
    return rec;
  });
  chain = next;
  return next;
}

// ───── The one job ─────

export type Phase = "idle" | "reading" | "thinking" | "listening" | "summing" | "done" | "error";
export interface LiveView {
  text: string;
  seconds: number;
  level: number;
  claims: Claim[];
  /** Pieces waiting for the AI. */
  pending: boolean;
  note?: string;
}
export interface FirewallState {
  phase: Phase;
  step: string;
  error?: string;
  result?: CheckRec;
  live?: LiveView;
}

let state: FirewallState = { phase: "idle", step: "" };
const listeners = new Set<() => void>();
const set = (patch: Partial<FirewallState>) => {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
};
export const firewallState = () => state;
export function subscribeFirewall(l: () => void) {
  listeners.add(l);
  return () => void listeners.delete(l);
}
export const firewallBusy = () => state.phase === "reading" || state.phase === "thinking" || state.phase === "listening" || state.phase === "summing";
/** Back to the empty form (a result stays on the page; it's only closed here). */
export function resetFirewall() {
  if (firewallBusy()) return;
  set({ phase: "idle", step: "", error: undefined, result: undefined, live: undefined });
}
/** Shows a saved check. */
export function showCheck(r: CheckRec) {
  if (firewallBusy()) return;
  set({ phase: "done", step: "", error: undefined, result: r, live: undefined });
}

/** The panel is on screen (finished checks then don't need a toast). */
let shown = 0;
export function showingFirewall(): () => void {
  shown++;
  return () => void shown--;
}
const done = (r: CheckRec) => {
  set({ phase: "done", step: "", result: r });
  if (!shown)
    showBackgroundToast(`🧯 Checked${r.speaker ? ` ${r.speaker}` : ""}: ${r.verdict || `${r.claims.length} claims`}`, "info", {
      label: "Open",
      run: () => window.dispatchEvent(new CustomEvent("journal:open-ai-chat", { detail: "firewall" })),
    });
};

/** A link (or the words) waiting for the panel to open with, e.g. from a link card's 🧯. */
let queued: string | null = null;
export function queueFirewall(input: string) {
  queued = input;
  window.dispatchEvent(new CustomEvent("journal:open-ai-chat", { detail: "firewall" }));
}
export function takeQueued(): string | null {
  const q = queued;
  queued = null;
  return q;
}

const loneUrl = (s: string) => /^https?:\/\/\S+$/.test(s.trim());

/** What the input is: a YouTube video, a web page, or words. */
export function sourceOf(input: string): SourceInfo {
  const t = input.trim();
  if (loneUrl(t)) {
    const id = youtubeId(t);
    return id ? { kind: "youtube", url: t } : { kind: "link", url: t };
  }
  return { kind: "text" };
}

/** 🧯 Checks a link or text. Resolves with the check (or null; the error shows in the panel). */
export async function checkSource(store: JournalStore, o: { input: string; speaker?: string; before?: number }, deps: Deps = defaultDeps): Promise<CheckRec | null> {
  if (firewallBusy()) return null;
  const source = sourceOf(o.input);
  set({ phase: "reading", step: source.kind === "youtube" ? "Getting the video…" : source.kind === "link" ? "Reading the page…" : "Reading…", error: undefined, result: undefined, live: undefined });
  const release = holdAwake();
  try {
    let text = "";
    if (source.kind === "youtube") {
      const m = await deps.meta(source.url!).catch(() => null);
      if (m?.title) source.title = m.title;
      text = m?.site ? `(Channel: ${m.site.replace(/^YouTube · /, "")})` : "";
    } else if (source.kind === "link") {
      const page = pageText(await deps.fetchHtml(source.url!));
      if (page.text.length < 200) throw new Error("Couldn't read words from that page (it may need a sign-in). Paste the text instead.");
      source.title = page.title || undefined;
      text = page.text;
    } else {
      text = o.input.trim();
      if (text.length < 60) throw new Error("Paste a link, or at least a few sentences to check.");
    }
    const provider = await deps.provider(source.kind === "youtube" ? "gemini" : "auto");
    const records = await loadChecks(store);
    const speaker = o.speaker?.trim() || knownSpeaker(records, `${source.title ?? ""} ${text.slice(0, 3000)}`);
    const prior = priorPremises(records, speaker);
    const room = BUDGET[provider];
    const body = source.kind === "youtube" ? text : text.length > room ? `${text.slice(0, room)}\n[…the rest was cut to fit]` : text;
    set({ phase: "thinking", step: source.kind === "youtube" ? "Gemini is watching the video and taking the arguments apart (a minute or two)…" : provider === "local" ? "The Mac's model is taking the arguments apart (a few minutes)…" : "Taking the arguments apart…" });
    const a = await askJson(
      deps,
      {
        task: "organise",
        provider,
        system: FIREWALL_SYSTEM,
        text: checkRequest({ source, text: body, speaker, prior }),
        ...(source.kind === "youtube" ? { files: [{ uri: watchUrl(youtubeId(source.url!)!) }] } : {}),
        schema: CHECK_SCHEMA,
        maxTokens: 16_000,
        timeoutMs: provider === "local" ? 600_000 : 300_000,
      },
      CHECK_SHAPE,
    );
    const c = normalizeCheck(a.json);
    if (!c.claims.length) throw new Error(c.verdict || "No arguments found to check in it.");
    const rec: CheckRec = {
      kind: "check",
      id: newId(),
      at: deps.now().toISOString(),
      by: a.actor,
      model: a.model,
      source,
      ...c,
      speaker: c.speaker || speaker,
      ...(typeof o.before === "number" ? { before: o.before } : {}),
    };
    await updateCheck(store, rec.id, () => rec, a.actor);
    done(rec);
    return rec;
  } catch (e) {
    set({ phase: "error", step: "", error: errText(e) });
    return null;
  } finally {
    release();
  }
}

// ───── Live listening ─────

let rec: LiveRecording | null = null;
let releaseAwake: (() => void) | null = null;
let cut = 0;
let inflight: Promise<void> = Promise.resolve();
let busyPiece = false;
let liveSpeaker = "";
let liveBefore: number | undefined;
let liveProvider: Provider = "gemini";
let liveDeps: Deps = defaultDeps;
let liveFailures = 0;

function auditPiece(piece: string): Promise<void> {
  busyPiece = true;
  const run = inflight.then(async () => {
    const claims = state.live?.claims ?? [];
    try {
      const a = await askJson(
        liveDeps,
        {
          task: liveProvider === "local" ? "describe" : "grammar",
          provider: liveProvider,
          system: LIVE_SYSTEM,
          text: chunkRequest({ piece, from: claims.length + 1, earlier: claims, speaker: liveSpeaker }),
          schema: CHUNK_SCHEMA,
          maxTokens: 4096,
          timeoutMs: liveProvider === "local" ? 240_000 : 60_000,
        },
        CHUNK_SHAPE,
      );
      const json = (a.json ?? {}) as { speaker?: string; claims?: unknown };
      if (!liveSpeaker && typeof json.speaker === "string" && json.speaker.trim().length > 1 && !/unknown|speaker/i.test(json.speaker)) liveSpeaker = json.speaker.trim().slice(0, 80);
      const now = state.live?.claims ?? [];
      const fresh = normalizeClaims(json.claims, now.length + 1, now.map((c) => c.n));
      liveFailures = 0;
      if (state.live) set({ live: { ...state.live, claims: [...now, ...fresh], note: undefined } });
    } catch (e) {
      // The piece is kept in the transcript; it's looked at again in the summary.
      liveFailures++;
      if (state.live) set({ live: { ...state.live, note: `Couldn't check a piece: ${errText(e)}` } });
    }
  });
  inflight = run.finally(() => {
    busyPiece = false;
    if (state.live) set({ live: { ...state.live, pending: false } });
  });
  return inflight;
}

/** 🎧 Starts listening (the microphone): words appear live, and every ~40 s of talk is audited. */
export async function startListening(store: JournalStore, o: { speaker?: string; before?: number }, deps: Deps = defaultDeps): Promise<void> {
  if (firewallBusy()) return;
  if (recordingVoice()) {
    set({ phase: "error", error: "The 🎙️ voice graph is recording; stop it first." });
    return;
  }
  liveDeps = deps;
  liveSpeaker = o.speaker?.trim() ?? "";
  liveBefore = o.before;
  liveFailures = 0;
  cut = 0;
  inflight = Promise.resolve();
  set({ phase: "listening", step: "Starting the microphone…", error: undefined, result: undefined, live: { text: "", seconds: 0, level: 0, claims: [], pending: false } });
  try {
    liveProvider = await deps.provider("auto");
    releaseAwake = holdAwake();
    rec = await deps.listen((s) => {
      if (state.phase !== "listening" || !state.live) return;
      const piece = s.text.slice(cut);
      let pending = state.live.pending;
      // Audit at a sentence end once enough has come in, one piece at a time (a slow answer makes the next piece bigger).
      if (!busyPiece && piece.length >= LIVE_PIECE && liveFailures < 3) {
        const end = Math.max(piece.lastIndexOf(". "), piece.lastIndexOf("? "), piece.lastIndexOf("! "));
        const upto = end > LIVE_PIECE / 2 ? end + 1 : piece.length;
        cut += upto;
        pending = true;
        void auditPiece(piece.slice(0, upto));
      }
      set({ step: "", live: { ...state.live, text: s.text, seconds: s.seconds, level: s.level, pending, note: s.note ?? state.live.note } });
    });
    void store;
  } catch (e) {
    rec = null;
    releaseAwake?.();
    releaseAwake = null;
    set({ phase: "error", step: "", error: errText(e), live: undefined });
  }
}

/** ⏹ Stops listening: the last words are audited, the whole is summed up and saved. */
export async function stopListening(store: JournalStore): Promise<CheckRec | null> {
  if (state.phase !== "listening" || !rec) return null;
  const r = rec;
  rec = null;
  set({ phase: "summing", step: "Finishing the words…" });
  try {
    const { text } = await r.stop();
    const rest = text.slice(cut).trim();
    if (rest.length >= 60) {
      set({ step: "Checking the last words…" });
      await auditPiece(rest);
    }
    await inflight;
    const claims = state.live?.claims ?? [];
    if (!claims.length) throw new Error(text.trim().length < 60 ? "Hardly anything was heard." : "No arguments came up in what was heard.");
    set({ step: "Summing up…" });
    const a = await askJson(
      liveDeps,
      {
        task: liveProvider === "local" ? "describe" : "grammar",
        provider: liveProvider,
        system: SUM_SYSTEM,
        text: `${liveSpeaker ? `Speaker: ${liveSpeaker}\n` : ""}Claims:\n${claims.map((c) => `${c.n}. "${c.quote}" → ${c.premise || c.claim} [${c.basis}${c.fallacies.length ? `; ${c.fallacies.join(", ")}` : ""}] heat ${c.heat}`).join("\n")}`,
        schema: SUM_SCHEMA,
        maxTokens: 4096,
        timeoutMs: liveProvider === "local" ? 240_000 : 60_000,
      },
      SUM_SHAPE,
    );
    const s = normalizeSummary(a.json, claims);
    const check: CheckRec = {
      kind: "check",
      id: newId(),
      at: liveDeps.now().toISOString(),
      by: a.actor,
      model: a.model,
      source: { kind: "live", title: s.topic || undefined },
      speaker: liveSpeaker,
      topic: s.topic,
      claims,
      contradictions: s.contradictions,
      past: [],
      heat: s.heat,
      verdict: s.verdict,
      steelman: s.steelman,
      holds: s.holds,
      ask: s.ask,
      ...(typeof liveBefore === "number" ? { before: liveBefore } : {}),
      transcript: text.slice(0, 20_000),
    };
    await updateCheck(store, check.id, () => check, a.actor);
    set({ live: undefined });
    done(check);
    return check;
  } catch (e) {
    set({ phase: "error", step: "", error: errText(e) });
    return null;
  } finally {
    releaseAwake?.();
    releaseAwake = null;
  }
}

/** Throws the listening away. */
export function cancelListening() {
  rec?.cancel();
  rec = null;
  releaseAwake?.();
  releaseAwake = null;
  set({ phase: "idle", step: "", live: undefined });
}

// ───── From the YouTube extension ─────

/**
 * A check the YouTube tracker extension made (its 🧯 on YouTube, through the MCP server): kept with
 * the app's own, one per video (sent again after "And now?" or a re-check, it replaces itself), so
 * both share one history and the speaker memory. Returns an error text, or the record.
 */
export async function saveExtensionCheck(store: JournalStore, data: string, actor: string): Promise<CheckRec | string> {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(data);
  } catch {
    return "data isn't JSON";
  }
  const videoId = typeof raw?.videoId === "string" && /^[\w-]{6,20}$/.test(raw.videoId) ? raw.videoId : null;
  if (!videoId) return "data has no videoId";
  const c = normalizeCheck(raw);
  if (!c.claims.length) return "data has no claims";
  const at = typeof raw.at === "string" && !Number.isNaN(Date.parse(raw.at)) ? raw.at : new Date().toISOString();
  const num = (v: unknown) => (typeof v === "number" && v >= 0 && v <= 10 ? Math.round(v) : undefined);
  const title = typeof raw.title === "string" ? raw.title.slice(0, 200) : "";
  const rec: CheckRec = {
    kind: "check",
    id: `yt-${videoId}`,
    at,
    by: typeof raw.by === "string" ? raw.by.slice(0, 40) : "Gemini",
    model: typeof raw.model === "string" ? raw.model.slice(0, 60) : "",
    source: { kind: "youtube", url: watchUrl(videoId), ...(title ? { title } : {}) },
    ...c,
    ...(num(raw.before) !== undefined ? { before: num(raw.before) } : {}),
    ...(num(raw.after) !== undefined ? { after: num(raw.after) } : {}),
  };
  await updateCheck(store, rec.id, () => rec, actor);
  return rec;
}

// ───── After a check ─────

/** "And now?": how convinced Hapi is after reading it (0–10). */
export async function setAfter(store: JournalStore, id: string, after: number) {
  const r = await updateCheck(store, id, (cur) => (cur ? { ...cur, after } : null), "me");
  if (r && state.result?.id === id) set({ result: r });
}

/** ＋ Today: the stripped argument in today's note (under the AI's name). */
export async function checkToToday(store: JournalStore, r: CheckRec, deps: Deps = defaultDeps) {
  await deps.appendLines(store, dayKey(deps.now()), todayLines(r), r.by || "AI");
}
