import Anthropic from "@anthropic-ai/sdk";
import { getKey } from "./secrets";
import { loadAiSettings, modelFor, recordUsage } from "./settings";
import type { AiTask, Provider } from "./providers";

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
}

export interface AiAnswer<T = unknown> {
  text: string;
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

async function callGemini(key: string, model: string, req: AiRequest) {
  const parts: Record<string, unknown>[] = [
    ...(req.images ?? []).map((img) => ({ inlineData: { mimeType: img.mime, data: img.data } })),
    { text: req.text },
  ];
  // In the app, through Tauri's native HTTP: the Android WebView's own fetch to Google can hang
  // (a cross-site request with a key header). A stalled connection still ends in an error.
  const http = "__TAURI_INTERNALS__" in window ? (await import("@tauri-apps/plugin-http")).fetch : fetch;
  const send = () => http(`${GEMINI}/models/${encodeURIComponent(model)}:generateContent`, {
    signal: AbortSignal.timeout(req.task === "organise" ? 90_000 : 20_000),
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: req.system }] },
      contents: [{ role: "user", parts }],
      generationConfig: {
        maxOutputTokens: req.maxTokens ?? 8192,
        ...(req.schema ? { responseMimeType: "application/json", responseSchema: req.schema } : {}),
      },
    }),
  });
  // "High demand" (503) or a rate limit (429) usually passes in seconds: try twice more.
  let res = await send();
  for (const wait of [2000, 5000]) {
    if (res.status !== 503 && res.status !== 429) break;
    await new Promise((r) => setTimeout(r, wait));
    res = await send();
  }
  if (!res.ok) throw await geminiError(res);
  const body = await res.json();
  const candidate = body.candidates?.[0];
  if (!candidate?.content) throw new Error(`Gemini returned no answer (${candidate?.finishReason ?? body.promptFeedback?.blockReason ?? "unknown"}).`);
  const text = (candidate.content.parts ?? []).map((p: { text?: string }) => p.text ?? "").join("");
  const u = body.usageMetadata ?? {};
  // Thinking tokens are billed as output.
  return { text, input: u.promptTokenCount ?? 0, output: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0) };
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
    system: req.system,
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
  const settings = loadAiSettings();
  if (!settings.enabled) throw new AiUnavailableError("off");
  const key = await getKey(settings.provider);
  if (!key) throw new AiUnavailableError("no-key");
  const model = modelFor(settings, req.task);
  const result = settings.provider === "gemini" ? await callGemini(key, model, req) : await callClaude(key, model, req);
  recordUsage(model, result.input, result.output);
  let json = undefined as T;
  if (req.schema) {
    try {
      json = JSON.parse(result.text) as T;
    } catch {
      throw new Error("The AI answer wasn't in the expected format; try again.");
    }
  }
  return { text: result.text, json, provider: settings.provider, model };
}

/** "Test key": one tiny request with this key. Resolves with the model that answered, or throws the error. */
export async function testKey(provider: Provider, key: string): Promise<string> {
  const model = modelFor({ ...loadAiSettings(), provider }, "grammar");
  const req: AiRequest = { task: "grammar", system: "Reply with the single word OK.", text: "Test", maxTokens: 16 };
  const result = provider === "gemini" ? await callGemini(key, model, { ...req, maxTokens: 64 }) : await callClaude(key, model, req);
  recordUsage(model, result.input, result.output);
  return model;
}
