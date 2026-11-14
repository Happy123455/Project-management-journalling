// Gemini with the journal's tools (function calling), for AI chat on the phone (and on the Mac when
// the local model isn't running). The same tools as the Mac's local model and MCP clients
// (src/ai/journalTools.ts + the block tools in src/ai/agent.ts), run by the same code.
import type { JournalStore } from "../store";
import type { Section } from "./blocks";
import { runOneTool, toolLogLine, toolsFor, type ToolCall } from "./agent";
import { geminiChain } from "./client";
import { getKey } from "./secrets";
import { loadAiSettings, modelFor, recordUsage } from "./settings";

const GEMINI = "https://generativelanguage.googleapis.com/v1beta";

type Part = { text?: string; thought?: boolean; functionCall?: { name: string; args?: Record<string, unknown> }; functionResponse?: unknown; thoughtSignature?: string };
interface Content {
  role: "user" | "model";
  parts: Part[];
}

/** Gemini's function declarations from our tool specs (no empty parameter objects). */
export function declarations(tools: { name: string; description: string; parameters: { properties: Record<string, unknown>; required?: string[] } }[]) {
  return tools.map((t) => {
    const props = t.parameters.properties;
    const has = Object.keys(props).length > 0;
    return {
      name: t.name,
      description: t.description,
      ...(has ? { parameters: { type: "object", properties: props, ...(t.parameters.required?.length ? { required: t.parameters.required } : {}) } } : {}),
    };
  });
}

export interface GeminiAgentResult {
  text: string;
  steps: string[];
  model: string;
  section?: Section | null;
}

/**
 * A chat answer from Gemini that may read and change the journal first (at most 8 rounds of tool
 * calls). `messages` is the conversation so far, the last one the user's.
 */
export async function geminiAgent(opts: {
  store: JournalStore;
  system: string;
  messages: { role: "user" | "assistant"; content: string }[];
  actor: string;
  section?: Section | null;
  signal?: AbortSignal;
  onStep?: (line: string) => void;
  fetchImpl?: typeof fetch;
}): Promise<GeminiAgentResult> {
  const key = await getKey("gemini");
  if (!key) throw new Error("Add a Gemini key in Settings → AI to use the journal's tools from here.");
  const http = opts.fetchImpl ?? ("__TAURI_INTERNALS__" in window ? (await import("@tauri-apps/plugin-http")).fetch : fetch);
  const model0 = modelFor({ ...loadAiSettings(), provider: "gemini" }, "chat");
  let section = opts.section;
  const contents: Content[] = opts.messages.map((m) => ({ role: m.role === "user" ? "user" : "model", parts: [{ text: m.content }] }));
  const steps: string[] = [];
  let chain = geminiChain(model0);
  for (let round = 0; round < 8; round++) {
    const tools = [{ functionDeclarations: declarations(toolsFor(section)) }];
    let json: { candidates?: { content?: Content; finishReason?: string }[]; usageMetadata?: Record<string, number> } | null = null;
    let used = chain[0];
    let lastError: Error | null = null;
    for (const m of chain) {
      let res: Response;
      try {
        res = await http(`${GEMINI}/models/${encodeURIComponent(m)}:generateContent`, {
          method: "POST",
          signal: opts.signal ?? AbortSignal.timeout(45_000),
          headers: { "Content-Type": "application/json", "x-goog-api-key": key },
          body: JSON.stringify({ systemInstruction: { parts: [{ text: opts.system }] }, contents, tools, generationConfig: { maxOutputTokens: 6000 } }),
        });
      } catch (e) {
        if (opts.signal?.aborted) throw new DOMException("Stopped", "AbortError");
        lastError = new Error(`Couldn't reach Gemini: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      if (res.status === 503 || res.status === 429 || res.status === 404 || res.status >= 500) {
        lastError = new Error(`Gemini ${res.status} on ${m}`);
        continue;
      }
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(/API key not valid/i.test(body) ? "The Gemini API key isn't valid." : `Gemini ${res.status}: ${body.slice(0, 160)}`);
      }
      json = await res.json();
      used = m;
      // Stay on the model that answered for the next rounds.
      chain = [m, ...chain.filter((x) => x !== m)];
      break;
    }
    if (!json) throw lastError ?? new Error("Gemini didn't answer.");
    const u = json.usageMetadata ?? {};
    recordUsage(used, u.promptTokenCount ?? 0, (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0));
    const content = json.candidates?.[0]?.content;
    const parts = content?.parts ?? [];
    const calls = parts.filter((p) => p.functionCall);
    const text = parts.map((p) => (p.thought || p.functionCall ? "" : p.text ?? "")).join("").trim();
    if (!calls.length) {
      if (!text) throw new Error(`Gemini returned no answer (${json.candidates?.[0]?.finishReason ?? "unknown"}).`);
      return { text, steps, model: used, section };
    }
    // Keep the model's turn exactly (thought signatures included), then answer each call.
    contents.push({ role: "model", parts });
    const answers: Part[] = [];
    for (const p of calls) {
      const call: ToolCall = { name: p.functionCall!.name, arguments: p.functionCall!.args ?? {} };
      const r = await runOneTool(opts.store, call, opts.actor, section);
      section = r.section;
      const line = toolLogLine(call, r.bad);
      steps.push(line);
      opts.onStep?.(line);
      answers.push({ functionResponse: { name: call.name, response: r.bad ? { error: r.out.slice(0, 6000) } : { result: r.out.slice(0, 6000) } } });
    }
    contents.push({ role: "user", parts: answers });
  }
  return { text: "(Stopped after several tool rounds.)", steps, model: chain[0], section };
}
