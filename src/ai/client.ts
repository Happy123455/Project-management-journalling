import Anthropic from "@anthropic-ai/sdk";
import { getKey } from "./secrets";
import { loadAiSettings, modelFor, recordUsage } from "./settings";
import { actorFor, OLLAMA_URL, type AiTask, type Provider } from "./providers";

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
  /** JSON Schema the answer must follow; the answer is then parsed and returned. */
  schema?: Record<string, unknown>;
  maxTokens?: number;
  /** Needs a cloud model (reading a picture): the local text model is skipped for Gemini when there's a key. */
  cloud?: boolean;
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

const GEMINI = "https://generativelanguage.googleapis.com/v1beta";

/** A Gemini API error as a short readable message. */
async function geminiError(res: Response): Promise<Error> {
  let message = `${res.status} ${res.statusText}`;
  try {
    const body = await res.json();
    if (body?.error?.message) message = body.error.message;
  } catch {
    // Keep the status line.
  }
  if (res.status === 400 && /API key not valid/i.test(message)) message = "The Gemini API key isn't valid.";
  if (res.status === 429) message = "Gemini rate limit reached — try again in a minute.";
  return new Error(message);
}

/**
 * Models to fall back on, in order, when the chosen one is overloaded (Google answers 503 "high
 * demand", often only after 30–50 s, which looked like the app had stopped responding), rate
 * limited, timed out or gone. Lite models answer in a couple of seconds.
 */
export const GEMINI_FALLBACKS = ["gemini-3.5-flash-lite", "gemini-flash-latest", "gemini-3.6-flash", "gemini-flash-lite-latest"];

/** A model that just failed is skipped for a while, so the next request doesn't wait on it again. */
const resting = new Map<string, number>();
const REST_MS = 10 * 60_000;

/** The models to try for a request, the chosen one first unless it failed in the last few minutes. */
export function geminiChain(model: string, now = Date.now(), rest: Map<string, number> = resting): string[] {
  const all = [model, ...GEMINI_FALLBACKS.filter((m) => m !== model)];
  const fresh = all.filter((m) => !rest.has(m) || now - rest.get(m)! >= REST_MS);
  return fresh.length ? fresh : all;
}

/** Worth trying the next model: overloaded, rate limited, unknown model, or no answer in time. */
const retryable = (status: number) => status === 503 || status === 429 || status === 404 || status === 500 || status === 504;

async function callGemini(key: string, model: string, req: AiRequest) {
  const parts: Record<string, unknown>[] = [
    ...(req.images ?? []).map((img) => ({ inlineData: { mimeType: img.mime, data: img.data } })),
    { text: req.text },
  ];
  // In the app, through Tauri's native HTTP: the Android WebView's own fetch to Google can hang
  // (a cross-site request with a key header). A stalled connection still ends in an error.
  const http = "__TAURI_INTERNALS__" in window ? (await import("@tauri-apps/plugin-http")).fetch : fetch;
  const body = (thinking: boolean) =>
    JSON.stringify({
      ...(req.system ? { systemInstruction: { parts: [{ text: req.system }] } } : {}),
      contents: [{ role: "user", parts }],
      generationConfig: {
        // Thinking models spend part of the output budget thinking: leave room so the answer isn't cut off.
        maxOutputTokens: (req.maxTokens ?? 8192) + (thinking ? 4096 : 0),
        ...(req.schema ? { responseMimeType: "application/json", responseSchema: req.schema } : {}),
      },
    });
  // Quick tasks give up on a slow model sooner and move on to the next one.
  const limit = req.task === "organise" ? 90_000 : req.images?.length ? 30_000 : 20_000;
  let lastError: Error | null = null;
  for (const m of geminiChain(model)) {
    let res: Response;
    try {
      res = await http(`${GEMINI}/models/${encodeURIComponent(m)}:generateContent`, {
        signal: AbortSignal.timeout(limit),
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: body(!m.includes("lite")),
      });
    } catch (e) {
      // Timed out or no connection: a timeout means this model is slow right now, try the next.
      const timedOut = e instanceof DOMException ? e.name === "TimeoutError" || e.name === "AbortError" : /timed? ?out|abort/i.test(String(e));
      if (!timedOut) throw new Error(`Couldn't reach Gemini: ${e instanceof Error ? e.message : String(e)}`);
      resting.set(m, Date.now());
      lastError = new Error(`Gemini (${m}) didn't answer in ${limit / 1000} s.`);
      continue;
    }
    if (!res.ok) {
      const err = await geminiError(res);
      if (!retryable(res.status)) throw err;
      resting.set(m, Date.now());
      lastError = err;
      continue;
    }
    resting.delete(m);
    const json = await res.json();
    const candidate = json.candidates?.[0];
    const text = (candidate?.content?.parts ?? []).map((p: { text?: string; thought?: boolean }) => (p.thought ? "" : p.text ?? "")).join("");
    if (!text) {
      const why = candidate?.finishReason ?? json.promptFeedback?.blockReason ?? "unknown";
      // Ran out of room thinking: another model may do it; a blocked prompt won't change.
      if (why === "MAX_TOKENS") {
        lastError = new Error("Gemini ran out of room before answering.");
        continue;
      }
      throw new Error(`Gemini returned no answer (${why}).`);
    }
    const u = json.usageMetadata ?? {};
    // Thinking tokens are billed as output.
    return { text, model: m, input: u.promptTokenCount ?? 0, output: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0) };
  }
  throw lastError ?? new Error("Gemini didn't answer.");
}

/** Ollama's chat API on this Mac (JSON mode when a schema is given; thinking only for the chat journal). */
async function callOllama(model: string, req: AiRequest) {
  const http = (await import("@tauri-apps/plugin-http")).fetch;
  const res = await http(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    signal: AbortSignal.timeout(req.task === "organise" || req.task === "chat" ? 300_000 : 120_000),
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

/** Is Ollama running on this Mac? */
export async function localAvailable(): Promise<boolean> {
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
      ...(req.schema ? { format: { type: "json_schema", schema: req.schema } } : {}),
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
  // The local model when it's running; otherwise Gemini (if it has a key) takes over.
  if (settings.provider === "local" && req.cloud && (await getKey("gemini"))) settings = { ...settings, provider: "gemini" };
  if (settings.provider === "local" && !(await localAvailable())) {
    if (!(await getKey("gemini"))) throw new Error("The local model (Ollama) isn't running, and there's no Gemini key to fall back on.");
    settings = { ...settings, provider: "gemini" };
  }
  let model = modelFor(settings, req.task);
  let result;
  if (settings.provider === "local") result = await callOllama(model, req);
  else {
    const key = await getKey(settings.provider);
    if (!key) throw new AiUnavailableError("no-key");
    if (settings.provider === "gemini") {
      result = await callGemini(key, model, req);
      model = result.model;
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
