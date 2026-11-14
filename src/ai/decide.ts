// Decision models: small, cheap yes/no, choice and score judgements by Gemini's Flash-Lite models,
// set up in AI chat (⚖️ Decide). A config says what goes in (input settings), what to ask
// (evaluation schema) and when the answer counts (scoring and thresholds). One built-in config
// decides where a new node goes in a graph (src/ai/voiceGraph.ts uses it), many lines per request.
import type { JournalStore } from "../store";
import { getKey } from "./secrets";
import { recordUsage } from "./settings";

export type QuestionType = "bool" | "choice" | "score";

export interface Question {
  key: string;
  type: QuestionType;
  instruction: string;
  /** choice: the options. */
  options?: string[];
  /** score: the scale and what its ends mean (the rubric). */
  min?: number;
  max?: number;
  rubric?: string;
  // ── Thresholds: when this answer passes ──
  /** bool: the answer that passes. */
  expect?: boolean;
  /** choice: the options that pass (empty: any). */
  accept?: string[];
  /** score: the lowest passing score. */
  pass?: number;
}

export interface DecisionConfig {
  id: string;
  name: string;
  input: {
    /** What is judged. */
    content: "text" | "text+image" | "image" | "audio";
    /** inline: one request per item; batch: many items in one request (cheaper). */
    delivery: "inline" | "batch";
    /** How finely images, video and audio are read (fewer tokens at low). */
    mediaResolution: "low" | "medium" | "high";
    model: string;
    /** Extra instructions before the questions. */
    instructions?: string;
  };
  questions: Question[];
  scoring: {
    /** all: every question must pass; any: one is enough. */
    mode: "all" | "any";
    /** Answers less sure than this (0–1) make the verdict "unsure". */
    minConfidence: number;
  };
}

export const DECIDE_MODELS = ["gemini-flash-lite-latest", "gemini-3.5-flash-lite", "gemini-flash-latest"];

export interface Answer {
  value: boolean | string | number;
  confidence: number;
  why?: string;
}
export interface Verdict {
  answers: Record<string, Answer>;
  passed: Record<string, boolean>;
  verdict: "yes" | "no" | "unsure";
}

export const newQuestion = (n: number): Question => ({ key: `q${n}`, type: "bool", instruction: "", expect: true });

export const NODE_PLACEMENT: DecisionConfig = {
  id: "node-placement",
  name: "Graph node placement",
  input: { content: "text", delivery: "batch", mediaResolution: "low", model: DECIDE_MODELS[0], instructions: "Each item is a new line for a mind-map graph. The branches already in the graph are listed in the options." },
  questions: [
    { key: "branch", type: "choice", instruction: "Which branch does this line belong to? Answer new when none fits.", options: [], accept: [] },
    { key: "fit", type: "score", instruction: "How well does the line fit that branch?", min: 1, max: 5, rubric: "1 = barely related, 5 = clearly part of it", pass: 3 },
  ],
  scoring: { mode: "all", minConfidence: 0.55 },
};

const resolution = { low: "MEDIA_RESOLUTION_LOW", medium: "MEDIA_RESOLUTION_MEDIUM", high: "MEDIA_RESOLUTION_HIGH" };

/** The JSON schema Gemini answers in, from the questions. */
export function answerSchema(questions: Question[]) {
  const props: Record<string, unknown> = {};
  for (const q of questions) {
    const value =
      q.type === "bool"
        ? { type: "boolean" }
        : q.type === "choice"
          ? { type: "string", ...(q.options?.length ? { enum: q.options } : {}) }
          : { type: "integer", minimum: q.min ?? 1, maximum: q.max ?? 5 };
    props[q.key] = { type: "object", properties: { value, confidence: { type: "number", description: "0 to 1" }, why: { type: "string" } }, required: ["value", "confidence"] };
  }
  return { type: "object", properties: props, required: questions.map((q) => q.key) };
}

/** The prompt's question list. */
export function questionText(c: DecisionConfig): string {
  return c.questions
    .map((q, i) => {
      const how =
        q.type === "bool"
          ? "yes/no (true or false)"
          : q.type === "choice"
            ? `one of: ${(q.options ?? []).map((o) => `"${o}"`).join(", ")}`
            : `a whole number from ${q.min ?? 1} to ${q.max ?? 5}${q.rubric ? ` (${q.rubric})` : ""}`;
      return `${i + 1}. ${q.key}: ${q.instruction || "(no instruction)"} Answer ${how}.`;
    })
    .join("\n");
}

/** Whether each answer passes its threshold, and the verdict. */
export function score(c: DecisionConfig, answers: Record<string, Answer>): Verdict {
  const passed: Record<string, boolean> = {};
  let unsure = false;
  for (const q of c.questions) {
    const a = answers[q.key];
    if (!a) {
      passed[q.key] = false;
      unsure = true;
      continue;
    }
    if (!(a.confidence >= c.scoring.minConfidence)) unsure = true;
    passed[q.key] =
      q.type === "bool"
        ? a.value === (q.expect ?? true)
        : q.type === "choice"
          ? !q.accept?.length || q.accept.includes(String(a.value))
          : Number(a.value) >= (q.pass ?? q.min ?? 1);
  }
  const vals = Object.values(passed);
  const ok = c.scoring.mode === "all" ? vals.every(Boolean) : vals.some(Boolean);
  return { answers, passed, verdict: unsure ? "unsure" : ok ? "yes" : "no" };
}

export interface DecideInput {
  text?: string;
  /** Images or audio, base64 without the data: prefix. */
  media?: { mime: string; data: string }[];
}

/**
 * One Gemini request through a chain of models (the next one when a model is busy or missing):
 * the answer's text, thoughts left out. Shared by the decision models and voice transcription.
 */
export async function geminiText(models: string[], body: Record<string, unknown>, fetchImpl?: typeof fetch, timeoutMs = 30_000): Promise<{ text: string; model: string }> {
  const key = await getKey("gemini");
  if (!key) throw new Error("This uses Gemini: add a key in Settings → AI.");
  const http = fetchImpl ?? ("__TAURI_INTERNALS__" in window ? (await import("@tauri-apps/plugin-http")).fetch : fetch);
  let last: Error | null = null;
  for (const m of [...new Set(models)]) {
    let res: Response;
    try {
      res = await http(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent`, {
        method: "POST",
        signal: AbortSignal.timeout(timeoutMs),
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify(body),
      });
    } catch (e) {
      last = new Error(`Couldn't reach Gemini: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    if (res.status === 503 || res.status === 429 || res.status === 404 || res.status >= 500) {
      last = new Error(`Gemini ${res.status} on ${m}`);
      continue;
    }
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(/API key not valid/i.test(t) ? "The Gemini API key isn't valid." : `Gemini ${res.status}: ${t.slice(0, 160)}`);
    }
    const json = await res.json();
    const u = json.usageMetadata ?? {};
    recordUsage(m, u.promptTokenCount ?? 0, (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0));
    const text = (json.candidates?.[0]?.content?.parts ?? []).map((p: { text?: string; thought?: boolean }) => (p.thought ? "" : p.text ?? "")).join("");
    return { text, model: m };
  }
  throw last ?? new Error("Gemini didn't answer.");
}

/** A JSON answer in `schema` (the next model when one gives unreadable JSON). */
export async function geminiJson(models: string[], contents: unknown[], schema: unknown, opts: { system?: string; mediaResolution?: DecisionConfig["input"]["mediaResolution"]; fetchImpl?: typeof fetch } = {}): Promise<unknown> {
  const chain = [...new Set(models)];
  let last: Error | null = null;
  for (let i = 0; i < chain.length; i++) {
    const { text, model } = await geminiText(chain.slice(i), {
      systemInstruction: { parts: [{ text: opts.system ?? "You are a careful classifier. Answer only in the JSON asked for; give each answer an honest confidence from 0 to 1." }] },
      contents,
      generationConfig: { responseMimeType: "application/json", responseSchema: schema, temperature: 0, mediaResolution: resolution[opts.mediaResolution ?? "low"], maxOutputTokens: 4096 },
    }, opts.fetchImpl);
    try {
      return JSON.parse(text);
    } catch {
      last = new Error(`Unreadable answer from ${model}`);
      i = chain.indexOf(model);
    }
  }
  throw last ?? new Error("Gemini didn't answer.");
}

const gemini = (c: DecisionConfig, contents: unknown[], schema: unknown, fetchImpl?: typeof fetch) =>
  geminiJson([c.input.model, ...DECIDE_MODELS], contents, schema, { mediaResolution: c.input.mediaResolution, fetchImpl });

const toAnswers = (raw: unknown, qs: Question[]): Record<string, Answer> => {
  const out: Record<string, Answer> = {};
  const o = (raw ?? {}) as Record<string, { value?: unknown; confidence?: unknown; why?: unknown }>;
  for (const q of qs) {
    const a = o[q.key];
    if (!a || a.value === undefined) continue;
    out[q.key] = { value: a.value as Answer["value"], confidence: Math.min(1, Math.max(0, Number(a.confidence) || 0)), ...(a.why ? { why: String(a.why).slice(0, 200) } : {}) };
  }
  return out;
};

/** Judges one input with a config. */
export async function decide(c: DecisionConfig, input: DecideInput, fetchImpl?: typeof fetch): Promise<Verdict> {
  const parts: unknown[] = [
    ...(input.media ?? []).map((m) => ({ inlineData: { mimeType: m.mime, data: m.data } })),
    { text: `${c.input.instructions ? `${c.input.instructions}\n\n` : ""}Questions:\n${questionText(c)}\n\nInput:\n${input.text ?? "(see the attachment)"}` },
  ];
  const raw = await gemini(c, [{ role: "user", parts }], answerSchema(c.questions), fetchImpl);
  return score(c, toAnswers(raw, c.questions));
}

/** Judges many text items in one request (delivery "batch"): one verdict per item, in order. */
export async function decideMany(c: DecisionConfig, items: string[], fetchImpl?: typeof fetch): Promise<Verdict[]> {
  if (!items.length) return [];
  const one = answerSchema(c.questions);
  const schema = { type: "object", properties: { items: { type: "array", items: { type: "object", properties: { i: { type: "integer" }, ...one.properties }, required: ["i", ...one.required] } } }, required: ["items"] };
  const text =
    `${c.input.instructions ? `${c.input.instructions}\n\n` : ""}Questions (answer them for every item, keeping its i):\n${questionText(c)}\n\nItems:\n` +
    items.map((t, i) => `${i}. ${t.replace(/\s+/g, " ").slice(0, 500)}`).join("\n");
  const raw = (await gemini(c, [{ role: "user", parts: [{ text }] }], schema, fetchImpl)) as { items?: ({ i?: number } & Record<string, unknown>)[] };
  const byI = new Map((raw.items ?? []).map((x) => [Number(x.i), x]));
  return items.map((_, i) => score(c, toAnswers(byI.get(i), c.questions)));
}

/**
 * Where each new line goes: the id of an existing branch, or null for a new one. Lines the
 * model isn't sure about (below the thresholds) get a new branch rather than a wrong one.
 */
export async function placeNodes(lines: string[], branches: { id: string; label: string }[], config: DecisionConfig = NODE_PLACEMENT, fetchImpl?: typeof fetch): Promise<(string | null)[]> {
  if (!branches.length) return lines.map(() => null);
  const labels = branches.map((b) => b.label.slice(0, 60));
  const c: DecisionConfig = {
    ...config,
    questions: config.questions.map((q) => (q.key === "branch" ? { ...q, type: "choice", options: [...labels, "new"], accept: labels } : q)),
  };
  const out: (string | null)[] = [];
  for (let s = 0; s < lines.length; s += 40) {
    const verdicts = await decideMany(c, lines.slice(s, s + 40), fetchImpl);
    for (const v of verdicts) {
      const pick = v.verdict === "yes" ? branches[labels.indexOf(String(v.answers.branch?.value))] : undefined;
      out.push(pick?.id ?? null);
    }
  }
  return out;
}

// ── Saved configs: the page "AI decision models" (syncs), a JSON block ──

export const DECIDE_PAGE = "AI decision models";

export async function loadConfigs(store: JournalStore): Promise<DecisionConfig[]> {
  const page = await store.getPage(DECIDE_PAGE);
  try {
    const list = JSON.parse(page?.content?.content?.[0]?.content?.[0]?.text ?? "[]") as DecisionConfig[];
    const saved = Array.isArray(list) ? list.filter((c) => c && c.id && Array.isArray(c.questions)) : [];
    return saved.some((c) => c.id === NODE_PLACEMENT.id) ? saved : [NODE_PLACEMENT, ...saved];
  } catch {
    return [NODE_PLACEMENT];
  }
}

export async function saveConfigs(store: JournalStore, list: DecisionConfig[]) {
  const page = await store.ensurePage(DECIDE_PAGE);
  const content = { type: "doc", content: [{ type: "codeBlock", attrs: { language: "json" }, content: [{ type: "text", text: JSON.stringify(list, null, 1) }] }] };
  await store.savePage({ id: page.id, content, plainText: `AI decision models: ${list.map((c) => c.name).join(", ")}`, actor: "me" });
}

/** The node placement config as saved (Hapi may have tuned it). */
export async function placementConfig(store: JournalStore): Promise<DecisionConfig> {
  return (await loadConfigs(store).catch(() => [NODE_PLACEMENT])).find((c) => c.id === NODE_PLACEMENT.id) ?? NODE_PLACEMENT;
}
