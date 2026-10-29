import { DEFAULT_MODELS, estimateCost, type AiTask, type Provider } from "./providers";

/** AI settings for this device only (browser storage): never in the journal, sync or backups. */
export interface AiSettings {
  enabled: boolean;
  provider: Provider;
  /** Offer grammar fixes after each finished paragraph. */
  grammarSuggestions: boolean;
  /** Apply grammar fixes automatically instead of suggesting them. Off unless turned on. */
  autoCorrect: boolean;
  /** Grow the mind map from today's note once it has rested a while. */
  mindmapAuto?: boolean;
  /** Per-task model overrides, e.g. { organise: "gemini-4-argon" }. */
  models: Partial<Record<Provider, Partial<Record<AiTask, string>>>>;
}

const SETTINGS_KEY = "dynamic-journal.ai-settings";
const USAGE_KEY = "dynamic-journal.ai-usage";

export const DEFAULT_SETTINGS: AiSettings = { enabled: true, provider: "gemini", grammarSuggestions: true, autoCorrect: false, models: {} };

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}

export const loadAiSettings = () => read(SETTINGS_KEY, DEFAULT_SETTINGS);

export function saveAiSettings(settings: AiSettings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Storage unavailable: the settings last for this session only.
  }
  window.dispatchEvent(new Event("journal:ai-settings"));
}

export const modelFor = (s: AiSettings, task: AiTask) => s.models[s.provider]?.[task] || DEFAULT_MODELS[s.provider][task];

export interface MonthUsage {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  /** Estimated USD at paid-tier prices (free-tier keys are not charged). */
  cost: number;
  /** Requests to models without a known price. */
  unpriced: number;
}

const emptyUsage = (): MonthUsage => ({ requests: 0, inputTokens: 0, outputTokens: 0, cost: 0, unpriced: 0 });

/** This month's AI use on this device. */
export const monthUsage = (month = new Date().toISOString().slice(0, 7)): MonthUsage =>
  read<Record<string, MonthUsage>>(USAGE_KEY, {})[month] ?? emptyUsage();

/** Adds one request's tokens to this month's totals. */
export function recordUsage(model: string, inputTokens: number, outputTokens: number, now = new Date()) {
  const all = read<Record<string, MonthUsage>>(USAGE_KEY, {});
  const month = now.toISOString().slice(0, 7);
  const u = all[month] ?? emptyUsage();
  const cost = estimateCost(model, inputTokens, outputTokens, now.toISOString().slice(0, 10));
  all[month] = {
    requests: u.requests + 1,
    inputTokens: u.inputTokens + inputTokens,
    outputTokens: u.outputTokens + outputTokens,
    cost: u.cost + (cost ?? 0),
    unpriced: u.unpriced + (cost === null ? 1 : 0),
  };
  try {
    localStorage.setItem(USAGE_KEY, JSON.stringify(all));
  } catch {
    // Not critical.
  }
  window.dispatchEvent(new Event("journal:ai-usage"));
}
