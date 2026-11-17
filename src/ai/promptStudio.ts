// ✍️ Prompt studio (in AI chat): describe a project, the Interviewer asks one question at a time,
// a second AI watches from another viewpoint, and both views are merged into one final prompt.
// The flows live here (not in the panel) so they keep going when the panel closes.
import type { Provider } from "./providers";
import type { AiRequest } from "./client";

export type Verdict = "join" | "dont";
export interface QA {
  q: string;
  a: string;
  topic: string;
}
export interface LogItem {
  who: "ai" | "me" | "crit";
  text: string;
  why?: string;
  sugs?: string[];
  topic?: string;
  kind?: string;
  askAlso?: string;
  queued?: boolean;
  by?: string;
}
export interface Point {
  title: string;
  verdict: Verdict;
  why: string;
  text: string;
  on: boolean;
}
export interface Review {
  summary: string;
  agreements: string[];
  points: Point[];
  comments: string[];
  scores: Record<string, number>;
  by?: string;
}
export interface Session {
  phase: "setup" | "interview" | "synth";
  brief: string;
  target: string;
  depth: number;
  persona: string;
  live: boolean;
  /** Who asks the questions and writes the draft, and who gives the second opinion. */
  asker: Provider;
  critic: Provider;
  log: LogItem[];
  qa: QA[];
  pending: { q: string; topic: string } | null;
  covered: string[];
  gaps: string[];
  extra: string[];
  draft: string;
  review: Review | null;
  final: string;
  done: boolean;
  /** What's running: "ask" (Interviewer), "crit" (second opinion), "draft", "review", "merge". */
  busy: string[];
  error: string;
}

export const TARGETS = [
  "a coding agent (Claude Code, Cursor) building software",
  "a general chat AI (Gemini, Claude, ChatGPT)",
  "an AI writing content (posts, scripts, essays)",
  "an image or video generator",
  "a research or analysis task",
];
export const PERSONAS: { id: string; label: string }[] = [
  { id: "a skeptic who hunts for gaps, contradictions and risks", label: "Skeptic: gaps and risks" },
  { id: "the engineer who will actually build this and needs exact, testable details", label: "Builder: exact details" },
  { id: "the end user who will live with the result every day", label: "End user: daily use" },
  { id: "a ruthless simplifier who cuts scope to what matters most", label: "Simplifier: cut scope" },
];

export const freshSession = (macLocal = false): Session => ({
  phase: "setup",
  brief: "",
  target: TARGETS[0],
  depth: 12,
  persona: PERSONAS[0].id,
  live: true,
  asker: "gemini",
  // A different model gives a truly different second view: the Mac's local model when there is one.
  critic: macLocal ? "local" : "gemini",
  log: [],
  qa: [],
  pending: null,
  covered: [],
  gaps: [],
  extra: [],
  draft: "",
  review: null,
  final: "",
  done: false,
  busy: [],
  error: "",
});

/* ---------- prompts ---------- */

export const transcript = (qa: QA[]) => qa.map((x, i) => `Q${i + 1} [${x.topic}]: ${x.q}\nA: ${x.a}`).join("\n\n") || "(no questions asked yet)";

export function askerPrompt(s: Session): string {
  return `You are the Interviewer inside a prompt-building tool. A person described a project. Interview them ONE question at a time to collect every detail needed to write an excellent prompt for ${s.target}.
Rules:
- Ask exactly one question, specific to THIS project (never generic). At most 2 short sentences, plain friendly English.
- Rough order: goal and what "done" looks like; who it is for; must-have features and scope; constraints (platform, tech, time, money); inputs and outputs, formats, examples; look, tone and style; edge cases and failures; what to avoid; then anything still unclear.
- Never re-ask something already answered. If an answer was vague, follow up once with a sharper question.
- If an answer was "You decide", move on (the prompt will mark it as an assumption).
- Give 2-4 short likely answers in "suggestions" the person can tap (each under 12 words).
- Budget: about ${s.depth} questions in total; ${s.qa.length} asked so far. Set "done" to true when nothing important is missing or the budget is reached (then "question" may be empty).

PROJECT DESCRIPTION:
${s.brief}

INTERVIEW SO FAR:
${transcript(s.qa)}${s.extra.length ? `\n\nQUESTIONS THE SECOND AI WANTS COVERED (ask them when they fit):\n- ${s.extra.join("\n- ")}` : ""}`;
}

export function critPrompt(s: Session): string {
  return `You are the Second Opinion, a different AI watching an interview between a person and an Interviewer AI that gathers details to write a prompt for ${s.target}. Your viewpoint: ${s.persona}.
React to the LATEST answer from your viewpoint, in the light of the whole project. Be brief and concrete; don't repeat what the Interviewer already asked.
"kind" is one of gap, contradiction, risk, idea, ok. "askAlso" is one question the Interviewer should add, or an empty string.

PROJECT DESCRIPTION:
${s.brief}

INTERVIEW:
${transcript(s.qa)}`;
}

export function draftPrompt(s: Session): string {
  return `Write the final prompt for ${s.target}, based on this project description and interview.
- Use clear headed sections: Role, Goal, Context, Requirements (Must / Should / Won't), Constraints, Inputs, Output and format, Style and tone, Edge cases, Avoid, Definition of done, and "Ask me first if unclear".
- Keep EVERY concrete detail, number, name and example the person gave. Use their wording where it matters.
- Don't invent facts. Where the person said "You decide" or skipped, write a sensible default marked [Assumption].
- Write it so the receiving AI can act without asking follow-ups.
Output only the prompt text, no preamble.

PROJECT DESCRIPTION:
${s.brief}

INTERVIEW:
${transcript(s.qa)}`;
}

export function reviewPrompt(s: Session): string {
  return `You are the Second Opinion, an independent AI with this viewpoint: ${s.persona}.
Compare two perspectives on the same project: (1) the PERSON's own words (description and interview answers) and (2) the INTERVIEWER's draft prompt. Add your own perspective too. Find where they agree, where the draft drifted from the person, what is missing, and ideas from your viewpoint.
For every suggested change give a verdict:
- "join": merge it into the prompt (fills a gap, fixes drift, sharpens a requirement).
- "dont": you considered it but advise NOT merging it (bloats scope, contradicts the person, or is speculation). Still list it so the person can decide.
Give 5-10 points, at least 2 of them "dont". "text" is the exact wording to add or change. Scores are 1-10 for the draft.

PROJECT DESCRIPTION:
${s.brief}

INTERVIEW:
${transcript(s.qa)}

DRAFT PROMPT:
${s.draft}`;
}

export function mergePrompt(s: Session): string {
  const pts = s.review?.points ?? [];
  const take = pts.filter((p) => p.on);
  const skip = pts.filter((p) => !p.on);
  return `Revise this prompt. Apply ONLY the accepted changes below, keep everything else and its structure. Do not apply the rejected ones. Output only the revised prompt.

ACCEPTED CHANGES:
${take.map((p) => `- ${p.title}: ${p.text}`).join("\n") || "(none)"}

REJECTED (keep out):
${skip.map((p) => `- ${p.title}`).join("\n") || "(none)"}

PROMPT:
${s.final || s.draft}`;
}

export const tweakPrompt = (s: Session, ask: string) => `Revise this prompt as requested. Keep everything else. Output only the revised prompt.

REQUEST: ${ask}

PROMPT:
${s.final}`;

/* ---------- answer shapes (Gemini responseSchema / Ollama format) ---------- */

const str = { type: "string" };
const strs = { type: "array", items: str };
export const ASK_SCHEMA = {
  type: "object",
  properties: { question: str, why: str, suggestions: strs, topic: str, covered: strs, gaps: strs, done: { type: "boolean" } },
  required: ["question", "why", "suggestions", "topic", "covered", "gaps", "done"],
};
export const CRIT_SCHEMA = { type: "object", properties: { comment: str, kind: str, askAlso: str }, required: ["comment", "kind", "askAlso"] };
export const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    summary: str,
    agreements: strs,
    points: {
      type: "array",
      items: { type: "object", properties: { title: str, verdict: { type: "string", enum: ["join", "dont"] }, why: str, text: str }, required: ["title", "verdict", "why", "text"] },
    },
    comments: strs,
    scores: { type: "object", properties: { clarity: { type: "integer" }, completeness: { type: "integer" }, specificity: { type: "integer" } }, required: ["clarity", "completeness", "specificity"] },
  },
  required: ["summary", "agreements", "points", "comments", "scores"],
};

const list = (v: unknown, n: number) => (Array.isArray(v) ? v.map(String).filter((x) => x.trim()).slice(0, n) : []);

/** The Interviewer's answer applied: the next question, or done. */
export function applyAsk(s: Session, r: Record<string, unknown>, by: string): Session {
  const covered = list(r.covered, 14);
  const gaps = list(r.gaps, 10);
  const q = String(r.question ?? "").trim();
  const next = { ...s, covered: covered.length ? covered : s.covered, gaps, log: [...s.log] };
  if (r.done === true || !q) {
    next.done = true;
    next.pending = null;
    next.log.push({ who: "ai", by, text: "I have what I need. Press “Write the prompt”, or add more notes first." });
  } else {
    const topic = String(r.topic ?? "").trim();
    next.pending = { q, topic };
    next.extra = s.extra.filter((x) => x !== q);
    next.log.push({ who: "ai", by, text: q, why: String(r.why ?? ""), sugs: list(r.suggestions, 4), topic });
  }
  return next;
}

/** The second AI's live comment goes just before the Interviewer's open question (it reacts to the answer before it). */
export function applyCrit(s: Session, r: Record<string, unknown>, by: string): Session {
  const text = String(r.comment ?? "").trim();
  if (!text) return s;
  const item: LogItem = { who: "crit", by, text, kind: String(r.kind ?? ""), askAlso: String(r.askAlso ?? "").trim() };
  const log = [...s.log];
  const last = log[log.length - 1];
  log.splice(s.pending && last?.who === "ai" ? log.length - 1 : log.length, 0, item);
  return { ...s, log };
}

export function toReview(r: Record<string, unknown>, by: string): Review {
  const pts = Array.isArray(r.points) ? (r.points as Record<string, unknown>[]) : [];
  const scores = (r.scores && typeof r.scores === "object" ? r.scores : {}) as Record<string, number>;
  return {
    by,
    summary: String(r.summary ?? ""),
    agreements: list(r.agreements, 12),
    comments: list(r.comments, 12),
    scores,
    points: pts.map((p) => {
      const verdict: Verdict = p.verdict === "dont" ? "dont" : "join";
      return { title: String(p.title ?? ""), verdict, why: String(p.why ?? ""), text: String(p.text ?? ""), on: verdict === "join" };
    }),
  };
}

/** A typed answer for the open question (or an extra note once the interview is done). */
export function answer(s: Session, text: string): Session {
  const t = text.trim();
  if (!t) return s;
  const qa = s.pending ? [...s.qa, { ...s.pending, a: t }] : [...s.qa, { q: "Extra note", a: t, topic: "note" }];
  return { ...s, qa, pending: null, done: false, log: [...s.log, { who: "me", text: t }] };
}

/** Takes back the last answer: its question is open again, with the answer back in the box. */
export function undo(s: Session): { s: Session; text: string } {
  if (!s.qa.length) return { s, text: "" };
  const last = s.qa[s.qa.length - 1];
  let i = s.log.length - 1;
  while (i >= 0 && s.log[i].who !== "me") i--;
  const log = i >= 0 ? s.log.slice(0, i) : [...s.log];
  while (log.length && log[log.length - 1].who === "crit") log.pop();
  return { s: { ...s, qa: s.qa.slice(0, -1), log, pending: { q: last.q, topic: last.topic }, done: false }, text: last.a === "(skipped)" ? "" : last.a };
}

/** The whole session as Markdown, for "Copy full conversation" and "＋ Today". */
export function conversationMd(s: Session): string {
  const persona = PERSONAS.find((p) => p.id === s.persona)?.label ?? s.persona;
  const L = [`# Prompt interview`, ``, `**Prompt is for:** ${s.target}`, `**Second AI viewpoint:** ${persona}`, ``, `## Project description`, ``, s.brief, ``, `## Conversation`, ``];
  for (const m of s.log) {
    const by = m.by ? ` (${m.by})` : "";
    if (m.who === "me") L.push(`**You:** ${m.text}`, ``);
    else if (m.who === "crit") L.push(`**Second opinion${by}${m.kind && m.kind !== "ok" ? ` · ${m.kind}` : ""}:** ${m.text}${m.askAlso ? `\n  Suggests asking: ${m.askAlso}` : ""}`, ``);
    else L.push(`**Interviewer${by}${m.topic ? ` [${m.topic}]` : ""}:** ${m.text}`, ``);
  }
  if (s.draft) L.push(`## Draft prompt (Interviewer)`, ``, "```", s.draft, "```", ``);
  const r = s.review;
  if (r) {
    L.push(`## Second opinion${r.by ? ` (${r.by})` : ""}`, ``, r.summary, ``);
    if (r.agreements.length) L.push(`**Agree:**`, ...r.agreements.map((a) => `- ${a}`), ``);
    if (r.points.length) L.push(`**Points:**`, ...r.points.map((p) => `- [${p.on ? "x" : " "}] ${p.verdict === "dont" ? "KEEP OUT" : "JOIN"} · ${p.title}: ${p.why}${p.text ? ` → ${p.text}` : ""}`), ``);
    if (r.comments.length) L.push(`**Comments:**`, ...r.comments.map((c) => `- ${c}`), ``);
  }
  if (s.final) L.push(`## Final prompt`, ``, "```", s.final, "```");
  return L.join("\n");
}

/* ---------- the running session (outlives the panel) ---------- */

const KEY = "dynamic-journal.prompt-studio";
type Ask = <T>(req: AiRequest) => Promise<{ text: string; json: T; actor: string }>;
let ask: Ask = async (req) => (await import("./client")).askAi(req);
/** Tests swap the AI. */
export const setAsk = (fn: Ask) => (ask = fn);

function loadSession(): Session | null {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? "null") as Session | null;
    // Nothing runs after a restart.
    return s ? { ...s, busy: [] } : null;
  } catch {
    return null;
  }
}
let S: Session = loadSession() ?? freshSession("__TAURI_INTERNALS__" in globalThis && !("JournalShare" in globalThis));
const listeners = new Set<() => void>();
export const studio = () => S;
export function subscribeStudio(l: () => void) {
  listeners.add(l);
  return () => void listeners.delete(l);
}
export function setStudio(next: Session | ((s: Session) => Session)) {
  S = typeof next === "function" ? next(S) : next;
  try {
    localStorage.setItem(KEY, JSON.stringify(S));
  } catch {
    // Only a convenience.
  }
  listeners.forEach((l) => l());
}
export const studioBusy = () => S.busy.length > 0;

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
async function run<T>(tag: string, fn: () => Promise<T>, quiet = false): Promise<T | null> {
  setStudio((s) => ({ ...s, busy: [...s.busy, tag], error: "" }));
  try {
    return await fn();
  } catch (e) {
    if (!quiet) setStudio((s) => ({ ...s, error: errText(e) }));
    return null;
  } finally {
    setStudio((s) => ({ ...s, busy: s.busy.filter((b) => b !== tag) }));
  }
}

// Quick turns use the fast model; the prompt itself and the comparison use the strong one.
const quick = (provider: Provider, system: string, text: string, schema: Record<string, unknown>): AiRequest => ({
  task: "describe",
  provider,
  system,
  text,
  schema,
  maxTokens: 1200,
  timeoutMs: provider === "local" ? 240_000 : 45_000,
});
const deep = (provider: Provider, text: string, schema?: Record<string, unknown>): AiRequest => ({
  task: "organise",
  provider,
  system: "You write precise, complete prompts for AI systems.",
  text,
  ...(schema ? { schema } : {}),
  maxTokens: 6000,
  timeoutMs: provider === "local" ? 480_000 : 150_000,
});

export async function nextQuestion() {
  const s = S;
  await run("ask", async () => {
    const r = await ask<Record<string, unknown>>(quick(s.asker, "Reply only with JSON in the given shape.", askerPrompt(s), ASK_SCHEMA));
    setStudio((cur) => applyAsk(cur, r.json ?? {}, r.actor));
  });
}

async function liveComment() {
  const s = S;
  if (!s.live) return;
  await run("crit", async () => {
    const r = await ask<Record<string, unknown>>(quick(s.critic, "Reply only with JSON in the given shape.", critPrompt(s), CRIT_SCHEMA));
    setStudio((cur) => applyCrit(cur, r.json ?? {}, r.actor));
  }, true); // A failed side comment never interrupts the interview.
}

export async function start(setup: Pick<Session, "brief" | "target" | "depth" | "persona" | "live" | "asker" | "critic">) {
  setStudio({ ...freshSession(), ...setup, phase: "interview" });
  await nextQuestion();
}

export async function send(text: string) {
  if (!text.trim() || S.busy.includes("ask")) return;
  setStudio((s) => answer(s, text));
  // The Interviewer and the second AI work side by side.
  await Promise.all([nextQuestion(), liveComment()]);
}

export function queueQuestion(i: number) {
  setStudio((s) => {
    const m = s.log[i];
    if (!m?.askAlso || m.queued) return s;
    const log = [...s.log];
    log[i] = { ...m, queued: true };
    return { ...s, log, extra: [...s.extra, m.askAlso] };
  });
}

export async function writeDraft() {
  setStudio((s) => ({ ...s, phase: "synth", draft: "", review: null, final: "" }));
  const s = S;
  const ok = await run("draft", async () => {
    const r = await ask<unknown>(deep(s.asker, draftPrompt(s)));
    setStudio((cur) => ({ ...cur, draft: r.text.trim() }));
    return true;
  });
  if (ok) await compare();
}

export async function compare() {
  setStudio((s) => ({ ...s, review: null }));
  const s = S;
  await run("review", async () => {
    const r = await ask<Record<string, unknown>>(deep(s.critic, reviewPrompt(s), REVIEW_SCHEMA));
    setStudio((cur) => ({ ...cur, review: toReview(r.json ?? {}, r.actor) }));
  });
}

export function togglePoint(i: number, on: boolean) {
  setStudio((s) => (s.review ? { ...s, review: { ...s.review, points: s.review.points.map((p, j) => (j === i ? { ...p, on } : p)) } } : s));
}

export async function merge() {
  const s = { ...S, final: "" };
  await run("merge", async () => {
    const r = await ask<unknown>(deep(s.asker, mergePrompt(s)));
    setStudio((cur) => ({ ...cur, final: r.text.trim() }));
  });
}

export async function tweak(request: string) {
  const s = S;
  if (!request.trim() || !s.final) return;
  await run("merge", async () => {
    const r = await ask<unknown>(deep(s.asker, tweakPrompt(s, request)));
    setStudio((cur) => ({ ...cur, final: r.text.trim(), log: [...cur.log, { who: "me", text: `Change to the final prompt: ${request.trim()}` }] }));
  });
}
