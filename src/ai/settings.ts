import type { CoolLevel } from "./local";
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
  /** Phone: leave growing the map to the Mac (its local model); results arrive by sync. */
  macGrowsMap?: boolean;
  /** Mac: the local model has been made the default once (the person can switch back). */
  localDefaultSet?: boolean;
  /** Mac: Gemini made the default once (25 Nov, Hapi got Gemini Pro and wants the Mac cool). */
  geminiDefaultSet?: boolean;
  /** Mac: how the local model is kept cool (bursts with rests); "cool" unless changed. */
  cool?: CoolLevel;
  /** 🛢️ The evening oil-drop check runs by itself (on unless turned off). */
  oilDrop?: boolean;
  /** The hour (0–23) it runs from; 21 unless changed. */
  oilDropHour?: number;
  /** Gemini: the order to fall back in when a model doesn't answer (ai/gemini.ts); Pro → Flash → Flash-Lite unless changed. */
  geminiOrder?: ("pro" | "flash" | "lite")[];
  /** Gemini: seconds to wait for Pro before moving on (45 unless changed). */
  geminiWaitS?: number;
  /** Floating agent: small deletions (up to agentDeleteWords words, or one block) go ahead without asking (on unless turned off). */
  agentFreeDelete?: boolean;
  /** Floating agent: how many words count as small (30 unless changed). */
  agentDeleteWords?: number;
  /** Floating agent: any one block counts as small, whatever its length (on unless turned off). */
  agentDeleteBlock?: boolean;
  /** Floating agent: "live" = Gemini Live hears the voice and acts (default); "whisper" = written down first, then Gemini text. */
  agentEngine?: "live" | "whisper";
  /** Floating agent: says what it did out loud (off unless turned on). */
  agentSpeak?: boolean;
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

export function loadAiSettings(): AiSettings {
  const s = read(SETTINGS_KEY, DEFAULT_SETTINGS);
  // Mac app: Gemini becomes the default once (25 Nov), so the Mac stays cool; Local stays one tap away.
  const desktop = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window && !window.JournalShare;
  if (desktop && !s.geminiDefaultSet) {
    const next = { ...s, provider: "gemini" as const, localDefaultSet: true, geminiDefaultSet: true };
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
    } catch {
      // Applied for this session.
    }
    return next;
  }
  return s;
}

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

/** Settings › Agent: the word limits offered for "delete small things without asking". */
export const DELETE_WORDS = [10, 30, 60, 100, 250];
