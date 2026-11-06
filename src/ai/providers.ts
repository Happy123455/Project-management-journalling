export type Provider = "gemini" | "claude" | "local";
export type AiTask = "grammar" | "organise" | "describe" | "chat";

export const PROVIDERS: { id: Provider; name: string; keyHelp: string }[] = [
  { id: "gemini", name: "Gemini", keyHelp: "Create a key at aistudio.google.com → Get API key." },
  { id: "claude", name: "Claude", keyHelp: "Create a key at platform.claude.com → API keys." },
  { id: "local", name: "Local (Ollama)", keyHelp: "Runs on this Mac with Ollama; no key, nothing leaves the Mac." },
];

/** Ollama on this Mac. */
export const OLLAMA_URL = "http://127.0.0.1:11434";

/** The name AI edits are recorded under (the event's actor), so they can be shown and undone. */
export const actorFor = (provider: Provider, model = "") =>
  provider === "gemini" ? "Gemini" : provider === "claude" ? "Claude" : `Local (${model.split(":")[0] || "model"})`;
export const AI_ACTORS = ["Gemini", "Claude"];

/**
 * Default models per task. Grammar and photo descriptions use a fast model; Organise uses a
 * stronger one. Gemini names are from Google AI Studio's model list (October 2026).
 */
export const DEFAULT_MODELS: Record<Provider, Record<AiTask, string>> = {
  // Chat journal: a cheap, fast model in the cloud; on the Mac the local model thinks first (free).
  gemini: { grammar: "gemini-3.8-flash", organise: "gemini-3.1-pro-preview", describe: "gemini-3.8-flash", chat: "gemini-3.5-flash-lite" },
  claude: { grammar: "claude-haiku-5-5", organise: "claude-sonnet-5-5", describe: "claude-haiku-5-5", chat: "claude-haiku-5-5" },
  // On the Mac: the small llama3.2 for quick fixes, the qwen3:14b reasoning model where thinking pays off.
  local: { grammar: "llama3.2", organise: "qwen3:14b", describe: "qwen3:14b", chat: "qwen3:14b" },
};

interface Price {
  /** USD per million input / output tokens. */
  input: number;
  output: number;
  /** The price applies before this date (YYYY-MM-DD); the next entry applies from it. */
  until?: string;
}

/** Paid-tier prices as published (Google AI pricing page; Anthropic models table), October 2026. */
const PRICES: Record<string, Price[]> = {
  "gemini-3.8-flash": [{ input: 0.75, output: 3.75, until: "2027-01-01" }, { input: 1.5, output: 7.5 }],
  "gemini-3.5-flash-lite": [{ input: 0.3, output: 2.5 }],
  "gemini-3.1-pro-preview": [{ input: 2, output: 12 }],
  "gemini-4-argon": [{ input: 2, output: 10, until: "2026-12-01" }, { input: 4, output: 20 }],
  "claude-haiku-5-5": [{ input: 0.1, output: 0.5 }],
  "claude-sonnet-5-5": [{ input: 2, output: 10 }],
  "claude-opus-5-5": [{ input: 4, output: 20 }],
};

/** Estimated cost in USD, or null for a model without a known price. Free-tier keys cost nothing. */
export function estimateCost(model: string, inputTokens: number, outputTokens: number, day: string): number | null {
  const prices = PRICES[model];
  if (!prices) return null;
  const price = prices.find((p) => !p.until || day < p.until) ?? prices[prices.length - 1];
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}
