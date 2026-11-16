// Gemini with the journal's tools (function calling), for AI chat on the phone (and on the Mac when
// the local model isn't running). The same tools as the Mac's local model and MCP clients
// (src/ai/journalTools.ts + the block tools in src/ai/agent.ts), run by the same code.
import type { JournalStore } from "../store";
import type { Section } from "./blocks";
import { runOneTool, toolLogLine, toolsFor, type ToolCall } from "./agent";
import { geminiChain } from "./client";
import { geminiCall } from "./gemini";
import { getKey } from "./secrets";
import { loadAiSettings, modelFor, recordUsage } from "./settings";


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
  /** The assistant (item 13): its own tool list and runner, model and number of rounds. */
  tools?: { name: string; description: string; parameters: { properties: Record<string, unknown>; required?: string[] } }[];
  runTool?: (call: ToolCall) => Promise<{ out: string; bad: boolean }>;
  model?: string;
  maxRounds?: number;
}): Promise<GeminiAgentResult> {
  const key = await getKey("gemini");
  if (!key) throw new Error("Add a Gemini key in Settings → AI to use the journal's tools from here.");
  const model0 = opts.model ?? modelFor({ ...loadAiSettings(), provider: "gemini" }, "chat");
  let section = opts.section;
  const contents: Content[] = opts.messages.map((m) => ({ role: m.role === "user" ? "user" : "model", parts: [{ text: m.content }] }));
  const steps: string[] = [];
  let chain = geminiChain(model0);
  const rounds = opts.maxRounds ?? 8;
  for (let round = 0; round < rounds; round++) {
    if (opts.signal?.aborted) throw new DOMException("Stopped", "AbortError");
    const tools = [{ functionDeclarations: declarations(opts.tools ?? toolsFor(section)) }];
    // One path for every Gemini call (ai/gemini.ts): a model that hangs, errors or answers with
    // nothing hands over to the next one.
    const r = await geminiCall({
      key,
      model: chain[0],
      chain,
      signal: opts.signal,
      fastTimeoutMs: 45_000,
      fetchImpl: opts.fetchImpl,
      body: () => ({ systemInstruction: { parts: [{ text: opts.system }] }, contents, tools, generationConfig: { maxOutputTokens: 6000 } }),
    });
    const json = r.json as { candidates?: { content?: Content; finishReason?: string }[]; usageMetadata?: Record<string, number> };
    const used = r.model;
    // Stay on the model that answered for the next rounds.
    chain = [used, ...chain.filter((x) => x !== used)];
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
      const r = opts.runTool ? await opts.runTool(call) : await runOneTool(opts.store, call, opts.actor, section);
      if (!opts.runTool) section = (r as { section?: Section | null }).section;
      const line = toolLogLine(call, r.bad);
      steps.push(line);
      opts.onStep?.(line);
      answers.push({ functionResponse: { name: call.name, response: r.bad ? { error: r.out.slice(0, 6000) } : { result: r.out.slice(0, 6000) } } });
    }
    contents.push({ role: "user", parts: answers });
  }
  return { text: "(Stopped after several tool rounds.)", steps, model: chain[0], section };
}
