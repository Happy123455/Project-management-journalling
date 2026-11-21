import { loadAiSettings } from "./settings";

/**
 * Every Gemini request goes through here (client.ts askAi, decide.ts geminiText/geminiJson for
 * decisions, voice and graphs, geminiTools.ts for chat with tools), so they all fall back the
 * same way. 16 Nov, Hapi: "some times gemini pro model isnt listening so route back to lower
 * model". Before, only an HTTP error (503, 429…) moved on to another model; a Pro request that
 * hung, came back empty or was blocked just failed or waited.
 *
 * Now, in the order set in Settings › AI (Pro → Flash → Flash-Lite unless changed):
 * - a model that doesn't answer within the wait (Settings, 45 s for Pro unless changed), answers
 *   with nothing, is blocked, runs out of room, is busy (503/429/5xx) or missing (404) is left
 *   for the next one;
 * - a model that failed is skipped for 10 minutes, so later requests go straight to the next;
 * - a small note says so ("Pro didn't answer, used Flash").
 */
export type Tier = "pro" | "flash" | "lite";
export const TIERS: Tier[] = ["pro", "flash", "lite"];
export const TIER_NAME: Record<Tier, string> = { pro: "Pro", flash: "Flash", lite: "Flash-Lite" };

/** Models per tier, the usual one first, then Google's "latest" names as a spare. */
export const TIER_MODELS: Record<Tier, string[]> = {
  pro: ["gemini-3.1-pro-preview"],
  flash: ["gemini-3.8-flash", "gemini-flash-latest", "gemini-3.6-flash"],
  lite: ["gemini-3.5-flash-lite", "gemini-flash-lite-latest", "gemini-3.1-flash-lite"],
};
export const tierOf = (model: string): Tier => (/-pro\b|pro-/.test(model) ? "pro" : /lite/.test(model) ? "lite" : "flash");

export const DEFAULT_ORDER: Tier[] = ["pro", "flash", "lite"];
export const DEFAULT_WAIT_S = 45;

/** A model that failed is skipped this long. */
export const REST_MS = 10 * 60_000;
const resting = new Map<string, number>();
/** For tests. */
export const restingModels = resting;

/** Settings › AI: the fallback order and how long to wait for a model. */
export function fallbackPrefs(): { order: Tier[]; waitS: number } {
  const s = loadAiSettings();
  const order = (s.geminiOrder ?? DEFAULT_ORDER).filter((t, i, a) => TIERS.includes(t) && a.indexOf(t) === i);
  for (const t of TIERS) if (!order.includes(t)) order.push(t);
  const waitS = Number.isFinite(s.geminiWaitS) && s.geminiWaitS! >= 5 ? s.geminiWaitS! : DEFAULT_WAIT_S;
  return { order, waitS };
}

/**
 * The models to try for `model`, in order: it first, then the tiers after it in `order` (the
 * lower ones), then the ones before it except Pro (a fast model is a better last try than a slow
 * one). Models resting after a failure go last.
 */
export function fallbackChain(model: string, order: Tier[] = DEFAULT_ORDER, now = Date.now(), rest: Map<string, number> = resting): string[] {
  const t = tierOf(model);
  const i = order.indexOf(t);
  const tiers = [...order.slice(i + 1), ...order.slice(0, Math.max(0, i)).filter((x) => x !== "pro")];
  const all = [...new Set([model, ...TIER_MODELS[t], ...tiers.flatMap((x) => TIER_MODELS[x])])];
  const tired = (m: string) => rest.has(m) && now - rest.get(m)! < REST_MS;
  return [...all.filter((m) => !tired(m)), ...all.filter(tired)];
}

/** Why a model's answer can't be used (the next one is tried), or null when it's fine. */
export function unusable(json: GeminiJson, allowEmpty = false): string | null {
  const c = json.candidates?.[0];
  const block = json.promptFeedback?.blockReason;
  if (block) return `blocked (${block})`;
  const parts = c?.content?.parts ?? [];
  const has = parts.some((p) => (p.text && !p.thought) || p.functionCall);
  if (has) return null;
  const why = c?.finishReason;
  if (why && !["STOP", "MAX_TOKENS"].includes(why)) return `blocked (${why})`;
  if (why === "MAX_TOKENS") return "ran out of room before answering";
  return allowEmpty ? null : "answered with nothing";
}

export interface GeminiJson {
  candidates?: { content?: { role?: string; parts?: GeminiPart[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: Record<string, number>;
}
export type GeminiPart = { text?: string; thought?: boolean; functionCall?: { name: string; args?: Record<string, unknown> }; [k: string]: unknown };

export interface GeminiCall {
  key: string;
  /** The model asked for (its tier decides the chain), or an explicit chain. */
  model: string;
  chain?: string[];
  /** The request body for a model (thinking models may need more room). */
  body: (model: string) => unknown;
  /** Per model, set by the caller for a long job (watching a video): how long to wait for any model. */
  timeoutMs?: number;
  /** Otherwise: the Settings wait for Pro, and this (30 s unless given) for the faster models. */
  fastTimeoutMs?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  /** An empty answer is a real answer (e.g. no speech to transcribe). */
  allowEmpty?: boolean;
  /** Don't show the "used Flash" note (the caller says it). */
  quiet?: boolean;
}

export interface GeminiResult {
  json: GeminiJson;
  model: string;
  /** Models that didn't answer, with why. */
  skipped: { model: string; why: string }[];
  /** "Pro didn't answer, used Flash" when another model answered. */
  note?: string;
}

const API = "https://generativelanguage.googleapis.com/v1beta";

async function errorText(res: Response): Promise<string> {
  let message = `${res.status} ${res.statusText}`;
  try {
    const body = await res.json();
    if (body?.error?.message) message = body.error.message;
  } catch {
    // Keep the status line.
  }
  if (res.status === 400 && /API key not valid/i.test(message)) message = "The Gemini API key isn't valid.";
  if (res.status === 429) message = "Gemini rate limit reached — try again in a minute.";
  return message;
}

/** The note shown when another model answered. */
export function fallbackNote(asked: string, used: string, why: string): string {
  const a = TIER_NAME[tierOf(asked)];
  const u = TIER_NAME[tierOf(used)];
  return a === u ? `${asked} ${why}, used ${used}` : `${a} ${why === "is resting" ? "is struggling" : "didn't answer"}, used ${u}`;
}

let lastNote = { text: "", at: 0 };
function showNote(text: string) {
  // Once in a while, not on every request while Pro rests.
  if (text === lastNote.text && Date.now() - lastNote.at < 5 * 60_000) return;
  lastNote = { text, at: Date.now() };
  void import("../lib/toast").then(({ showToast }) => showToast(`🤖 ${text}`, "info", undefined, { background: true })).catch(() => {});
}

/** Models that answered 400 to a thinkingConfig: asked without it from then on. */
const noThinking = new Set<string>();
/** Gemini 3 models take thinkingLevel; older ones (and any that refused it) don't. */
export const canSetThinking = (m: string) => !noThinking.has(m) && /gemini-(?:[3-9]|flash|pro)/.test(m);

/** One Gemini generateContent request, falling back along the chain. */
export async function geminiCall(c: GeminiCall): Promise<GeminiResult> {
  const { order, waitS } = fallbackPrefs();
  const chain = c.chain?.length ? [...new Set(c.chain)] : fallbackChain(c.model, order);
  const first = c.chain?.length ? c.chain[0] : c.model;
  const http = c.fetchImpl ?? (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window ? (await import("@tauri-apps/plugin-http")).fetch : fetch);
  const skipped: GeminiResult["skipped"] = [];
  let lastError: Error | null = null;
  // The model asked for failed a few minutes ago: it's tried last (fallbackChain), and the note says so.
  const firstResting = resting.has(first) && Date.now() - resting.get(first)! < REST_MS;
  for (let k = 0; k < chain.length; k++) {
    const m = chain[k];
    if (c.signal?.aborted) throw new DOMException("Stopped", "AbortError");
    const limit = c.timeoutMs ?? (tierOf(m) === "pro" ? waitS * 1000 : (c.fastTimeoutMs ?? 30_000));
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(new DOMException("timeout", "TimeoutError")), limit);
    const onAbort = () => ctl.abort(new DOMException("Stopped", "AbortError"));
    c.signal?.addEventListener("abort", onAbort);
    let res: Response;
    try {
      res = await http(`${API}/models/${encodeURIComponent(m)}:generateContent`, {
        method: "POST",
        signal: ctl.signal,
        headers: { "Content-Type": "application/json", "x-goog-api-key": c.key },
        body: JSON.stringify(c.body(m)),
      });
    } catch (e) {
      clearTimeout(timer);
      c.signal?.removeEventListener("abort", onAbort);
      if (c.signal?.aborted) throw new DOMException("Stopped", "AbortError");
      const timedOut = ctl.signal.aborted || (e instanceof DOMException ? e.name === "TimeoutError" || e.name === "AbortError" : /timed? ?out|abort/i.test(String(e)));
      if (!timedOut) throw new Error(`Couldn't reach Gemini: ${e instanceof Error ? e.message : String(e)}`);
      resting.set(m, Date.now());
      skipped.push({ model: m, why: `no answer in ${Math.round(limit / 1000)} s` });
      lastError = new Error(`Gemini (${m}) didn't answer in ${Math.round(limit / 1000)} s.`);
      continue;
    }
    let json: GeminiJson;
    try {
      if (!res.ok) {
        const message = await errorText(res);
        // A bad key or a refused request won't change with another model.
        if (res.status === 401 || res.status === 403 || (res.status === 400 && /API key/i.test(message))) throw new Error(message);
        // The model doesn't take thinkingConfig: the same model again, without it.
        if (res.status === 400 && /thinking/i.test(message) && !noThinking.has(m)) {
          noThinking.add(m);
          k--;
          continue;
        }
        resting.set(m, Date.now());
        skipped.push({ model: m, why: `error ${res.status}` });
        lastError = new Error(message);
        continue;
      }
      json = (await res.json()) as GeminiJson;
    } catch (e) {
      if (e instanceof Error && !/JSON/i.test(e.message)) throw e;
      resting.set(m, Date.now());
      skipped.push({ model: m, why: "sent an unreadable answer" });
      lastError = new Error("Gemini sent an unreadable answer.");
      continue;
    } finally {
      clearTimeout(timer);
      c.signal?.removeEventListener("abort", onAbort);
    }
    const bad = unusable(json, c.allowEmpty);
    if (bad) {
      resting.set(m, Date.now());
      skipped.push({ model: m, why: bad });
      lastError = new Error(`Gemini ${bad}.`);
      continue;
    }
    resting.delete(m);
    const why = firstResting ? "is resting" : skipped[0]?.why;
    const note = m !== first && why ? fallbackNote(first, m, why) : undefined;
    if (note && !c.quiet) showNote(note);
    return { json, model: m, skipped, note };
  }
  throw lastError ?? new Error("Gemini didn't answer.");
}

/** The answer's text, thoughts left out. */
export const answerText = (json: GeminiJson) =>
  (json.candidates?.[0]?.content?.parts ?? []).map((p) => (p.thought || p.functionCall ? "" : p.text ?? "")).join("");

/** Tokens of an answer: [input, output] (thinking is billed as output). */
export function usageOf(json: GeminiJson): [number, number] {
  const u = json.usageMetadata ?? {};
  return [u.promptTokenCount ?? 0, (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0)];
}
