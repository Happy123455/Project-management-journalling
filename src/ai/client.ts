import Anthropic from "@anthropic-ai/sdk";
import { getKey } from "./secrets";
import { loadAiSettings, modelFor, recordUsage } from "./settings";
import { actorFor, OLLAMA_URL, type AiTask, type Provider } from "./providers";
import { answerText, fallbackChain, fallbackPrefs, geminiCall, usageOf } from "./gemini";

/** Thrown when AI is off or no key is set; the UI shows "add your key in Settings". */
export class AiUnavailableError extends Error {
  constructor(public reason: "off" | "no-key") {
    super(reason === "off" ? "AI features are turned off in Settings." : "Add your API key in Settings → AI.");
  }
}

export interface AiImage {
  mime: string;
  /** Base64, no data: prefix. */
  data: string;
}

export interface AiRequest {
  task: AiTask;
  system: string;
  text: string;
  images?: AiImage[];
  /**
   * Gemini only: files it reads by address, e.g. a public YouTube video it watches itself
   * ({ uri: "https://www.youtube.com/watch?v=…" }). Watched at low resolution (fewer tokens).
   */
  files?: { uri: string; mime?: string }[];
  /** JSON Schema the answer must follow; the answer is then parsed and returned. */
  schema?: Record<string, unknown>;
  maxTokens?: number;
  /** Needs a cloud model (reading a picture): the local text model is skipped for Gemini when there's a key. */
  cloud?: boolean;
  /** This provider instead of the one in Settings (the local model still falls back to Gemini when it isn't running). */
  provider?: Provider;
  /** This model instead of the task's (used only when the request stays with `provider`). */
  model?: string;
  /** How long to wait for the answer, instead of the task's usual limit. */
  timeoutMs?: number;
}

export interface AiAnswer<T = unknown> {
  text: string;
  /** Who made the change, for the event log (e.g. "Gemini", "Local (qwen3)"). */
  actor: string;
  /** Parsed JSON when a schema was given. */
  json: T;
  provider: Provider;
  model: string;
}

/** The models a request for `model` may end up on, in order (see ai/gemini.ts). */
export const geminiChain = (model: string, now = Date.now(), rest?: Map<string, number>) => fallbackChain(model, fallbackPrefs().order, now, rest);

async function callGemini(key: string, model: string, req: AiRequest) {
  const parts: Record<string, unknown>[] = [
    ...(req.images ?? []).map((img) => ({ inlineData: { mimeType: img.mime, data: img.data } })),
    ...(req.files ?? []).map((f) => ({ fileData: { fileUri: f.uri, ...(f.mime ? { mimeType: f.mime } : {}) } })),
    { text: req.text },
  ];
  // In the app the request goes through Tauri's native HTTP (ai/gemini.ts): the Android WebView's
  // own fetch to Google can hang (a cross-site request with a key header).
  const body = (m: string) => {
    const thinking = !m.includes("lite");
    return {
      ...(req.system ? { systemInstruction: { parts: [{ text: req.system }] } } : {}),
      contents: [{ role: "user", parts }],
      generationConfig: {
        // Thinking models spend part of the output budget thinking: leave room so the answer isn't cut off.
        maxOutputTokens: (req.maxTokens ?? 8192) + (thinking ? 4096 : 0),
        // A video at low resolution: about a third of the tokens, and speech is what matters.
        ...(req.files?.length ? { mediaResolution: "MEDIA_RESOLUTION_LOW" } : {}),
        ...(req.schema ? { responseMimeType: "application/json", responseSchema: req.schema } : {}),
      },
    };
  };
  // Pro waits as long as Settings says; quick tasks give up on a slow fast model sooner.
  // 21 Nov: Flash often sat 10–30 s on a 503 (busy at Google): give up sooner, a Lite answers in ~1 s.
  const fast = req.task === "organise" ? 90_000 : req.images?.length ? 30_000 : 12_000;
  const r = await geminiCall({ key, model, body, timeoutMs: req.timeoutMs, fastTimeoutMs: fast });
  const [input, output] = usageOf(r.json);
  return { text: answerText(r.json), model: r.model, input, output, note: r.note };
}

/** Ollama's chat API on this Mac (JSON mode when a schema is given; thinking only for the chat journal). */
async function callOllama(model: string, req: AiRequest) {
  const http = (await import("@tauri-apps/plugin-http")).fetch;
  const res = await http(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    signal: AbortSignal.timeout(req.timeoutMs ?? (req.task === "organise" || req.task === "chat" ? 300_000 : 120_000)),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      // The chat journal gets the reasoning model's thinking (it's local and free); edits stay quick.
      think: req.task === "chat",
      ...(req.schema ? { format: req.schema } : {}),
      // The same window as AI chat (src/ai/local.ts), so switching between them doesn't reload the model.
      options: { num_ctx: 16384 },
      keep_alive: "15m",
      messages: [
        ...(req.system ? [{ role: "system", content: req.system }] : []),
        { role: "user", content: req.text, ...(req.images?.length ? { images: req.images.map((i) => i.data) } : {}) },
      ],
    }),
  });
  if (!res.ok) throw new Error(`The local model answered ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const body = await res.json();
  return { text: body.message?.content ?? "", input: body.prompt_eval_count ?? 0, output: body.eval_count ?? 0 };
}

/** One request to this Mac's local model only (free, nothing leaves the Mac); quick tasks use the small model. */
export async function askLocal(req: AiRequest & { model?: string }): Promise<{ text: string; model: string }> {
  const model = req.model || modelFor({ ...loadAiSettings(), provider: "local" }, req.task);
  const r = await callOllama(model, req);
  recordUsage(model, r.input, r.output);
  return { text: r.text, model };
}

/**
 * Should the Mac's own model do this? Only when Settings → AI says "Local" and Ollama is running
 * (25 Nov: Hapi has Gemini now and doesn't want the Mac hot, so Gemini is the default there too).
 */
export async function localAvailable(): Promise<boolean> {
  return loadAiSettings().provider === "local" && ollamaUp();
}

/** Is Ollama running on this Mac (whatever Settings says)? */
export async function ollamaUp(): Promise<boolean> {
  try {
    const http = (await import("@tauri-apps/plugin-http")).fetch;
    return (await http(`${OLLAMA_URL}/api/version`, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
}

/** The models Ollama has downloaded. */
export async function localModels(): Promise<string[]> {
  try {
    const http = (await import("@tauri-apps/plugin-http")).fetch;
    const body = await (await http(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) })).json();
    return (body.models ?? []).map((m: { name: string }) => m.name);
  } catch {
    return [];
  }
}

/** Claude's structured output wants every object closed (additionalProperties: false). */
export function closedSchema(schema: unknown): Record<string, unknown> {
  const walk = (s: unknown): unknown => {
    if (Array.isArray(s)) return s.map(walk);
    if (!s || typeof s !== "object") return s;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(s)) out[k] = k === "properties" && v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, walk(pv)])) : walk(v);
    if (out.type === "object" && out.additionalProperties === undefined) out.additionalProperties = false;
    return out;
  };
  return walk(schema) as Record<string, unknown>;
}

async function callClaude(key: string, model: string, req: AiRequest) {
  // The key belongs to the person using the app and stays on their device, so a direct call is fine here.
  const client = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true });
  const content: Anthropic.Beta.BetaContentBlockParam[] = [
    ...(req.images ?? []).map(
      (img): Anthropic.Beta.BetaImageBlockParam => ({
        type: "image",
        source: { type: "base64", media_type: img.mime as "image/png", data: img.data },
      }),
    ),
    { type: "text", text: req.text },
  ];
  const response = await client.beta.messages.create({
    model,
    max_tokens: req.maxTokens ?? 16000,
    ...(req.system ? { system: req.system } : {}),
    messages: [{ role: "user", content }],
    // Quick edits don't need deep thinking.
    output_config: {
      effort: req.task === "organise" ? "medium" : "low",
      ...(req.schema ? { format: { type: "json_schema", schema: closedSchema(req.schema) } } : {}),
    },
    // If Sonnet declines a request, the API retries it on a suitable model (Claude API only).
    ...(model.startsWith("claude-sonnet") ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
  });
  if (response.stop_reason === "refusal") throw new Error("Claude declined this request.");
  const text = response.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  return { text, input: response.usage.input_tokens, output: response.usage.output_tokens };
}

/** Makes one AI request with the provider and key from Settings. Only call this on a clear user action. */
export async function askAi<T = unknown>(req: AiRequest): Promise<AiAnswer<T>> {
  let settings = loadAiSettings();
  if (!settings.enabled) throw new AiUnavailableError("off");
  if (req.provider) settings = { ...settings, provider: req.provider };
  const wanted = settings.provider;
  // The local model when it's running; otherwise Gemini (if it has a key) takes over.
  if (req.files?.length && settings.provider !== "gemini") {
    // Only Gemini can watch a video by its address.
    if (!(await getKey("gemini"))) throw new Error("Watching a video needs Gemini: add a Gemini key in Settings → AI.");
    settings = { ...settings, provider: "gemini" };
  }
  if (settings.provider === "local" && req.cloud && (await getKey("gemini"))) settings = { ...settings, provider: "gemini" };
  if (settings.provider === "local" && !(await ollamaUp())) {
    if (!(await getKey("gemini"))) throw new Error("The local model (Ollama) isn't running, and there's no Gemini key to fall back on.");
    settings = { ...settings, provider: "gemini" };
  }
  let model = req.model && settings.provider === wanted ? req.model : modelFor(settings, req.task);
  let result;
  if (settings.provider === "local") result = await callOllama(model, req);
  else {
    const key = await getKey(settings.provider);
    if (!key) throw new AiUnavailableError("no-key");
    if (settings.provider === "gemini") {
      try {
        result = await callGemini(key, model, req);
        model = result.model;
      } catch (e) {
        // 22 Nov, Hapi: "I want result." Gemini gave nothing after minutes of tries: the Mac's own model.
        if ((e as { name?: string })?.name === "AbortError" || req.files?.length || !(await ollamaUp())) throw e;
        settings = { ...settings, provider: "local" };
        model = modelFor(settings, req.task);
        result = await callOllama(model, req);
      }
    } else result = await callClaude(key, model, req);
  }
  recordUsage(model, result.input, result.output);
  let json = undefined as T;
  if (req.schema) {
    try {
      json = JSON.parse(result.text) as T;
    } catch {
      throw new Error("The AI answer wasn't in the expected format; try again.");
    }
  }
  return { text: result.text, json, provider: settings.provider, model, actor: actorFor(settings.provider, model) };
}

/** "Test key": one tiny request with this key. Resolves with the model that answered, or throws the error. */
export async function testKey(provider: Provider, key: string): Promise<string> {
  const model = modelFor({ ...loadAiSettings(), provider }, "grammar");
  const req: AiRequest = { task: "grammar", system: "Reply with the single word OK.", text: "Test", maxTokens: 16 };
  if (provider === "local") {
    await callOllama(model, { ...req, system: 'Reply with JSON: {"ok": true}', schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] } });
    return model;
  }
  if (provider === "gemini") {
    const result = await callGemini(key, model, { ...req, maxTokens: 64 });
    recordUsage(result.model, result.input, result.output);
    return result.model === model ? model : `${result.model} (${model} is busy at Google right now)`;
  }
  const result = await callClaude(key, model, req);
  recordUsage(model, result.input, result.output);
  return model;
}
