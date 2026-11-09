import { OLLAMA_URL } from "./providers";

/**
 * The local model (Ollama on the Mac) run "cool": the answer is made in short bursts with rests in
 * between, so a fanless Mac never sits at full GPU power for minutes. Nothing about the model or its
 * thinking is cut, it only takes longer. When the chip starts slowing itself down (it's hot, so each
 * burst gets fewer tokens a second), the rests get longer until it recovers.
 *
 * Qwen models speak ChatML, so the prompt is written here in raw mode: then a burst that stops at
 * its token limit can simply be continued with what it wrote so far (Ollama reuses the cache).
 */

export type CoolLevel = "off" | "cool" | "cold";

export interface LocalMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Share of the time the model works: "cool" works half the time, "cold" a third. */
const DUTY: Record<CoolLevel, number> = { off: 1, cool: 0.5, cold: 0.33 };
/** Tokens per burst (about 6–10 s on an M-series Air with a 14B model). */
const BURST = 160;
/** No answer goes on forever. */
const MAX_TOKENS = 16_000;

/** The ChatML prompt for these messages, ending where the assistant starts (thinking opened or skipped). */
export function chatml(messages: LocalMessage[], think: boolean): string {
  const turns = messages.map((m) => `<|im_start|>${m.role}\n${m.content}<|im_end|>\n`).join("");
  return `${turns}<|im_start|>assistant\n${think ? "<think>\n" : "<think>\n\n</think>\n\n"}`;
}

/** Splits what the model wrote (after the opening <think>) into its thinking and its answer. */
export function splitThinking(raw: string, think: boolean): { thinking: string; answer: string } {
  if (!think) return { thinking: "", answer: raw.trim() };
  const end = raw.indexOf("</think>");
  if (end < 0) return { thinking: raw.trim(), answer: "" };
  return { thinking: raw.slice(0, end).trim(), answer: raw.slice(end + 8).trim() };
}

/** How long to rest after a burst: by the duty share, longer when the chip has slowed down (hot). */
export function restMs(level: CoolLevel, burstMs: number, speed: number, best: number): number {
  if (level === "off") return 0;
  const work = DUTY[level];
  let rest = (burstMs * (1 - work)) / work;
  // Slower than its best by a fifth or more: the Mac is throttling itself, so give it more air.
  if (best > 0 && speed < best * 0.8) rest *= speed < best * 0.6 ? 3 : 2;
  return Math.min(60_000, Math.max(1500, rest));
}

/** What the assistant has written so far, as it goes after the prompt's opening <think>. */
export function continuation(thinking: string, answer: string, think: boolean): string {
  if (!think) return answer;
  return answer ? `${thinking.replace(/\s+$/, "")}\n</think>\n\n${answer}` : thinking;
}

/** Adds one burst's output: Ollama's separate thinking field, or (older versions) a raw </think> in the text. */
export function addBurst(thinking: string, answer: string, thinkingNow: boolean, t: string, r: string): { thinking: string; answer: string } {
  thinking += t;
  if (thinkingNow && !t && r.includes("</think>")) {
    const s = splitThinking(thinking + r, true);
    return { thinking: s.thinking, answer: s.answer };
  }
  return { thinking, answer: answer + (thinkingNow && !t && !answer ? r.replace(/^\s+/, "") : r) };
}

export const isChatml = (model: string) => /qwen|qwq/i.test(model);

export interface CoolProgress {
  thinking: string;
  answer: string;
  /** Resting until this time (ms), or 0 while working. */
  restUntil: number;
  /** Tokens a second in the last burst. */
  speed: number;
  /** The Mac looked hot (the model slowed down) at the last burst. */
  hot: boolean;
}

export interface CoolOptions {
  model: string;
  messages: LocalMessage[];
  think?: boolean;
  level: CoolLevel;
  numCtx?: number;
  signal?: AbortSignal;
  onProgress?: (p: CoolProgress) => void;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), reject(new DOMException("Stopped", "AbortError"))), { once: true });
  });

async function http() {
  return "__TAURI_INTERNALS__" in window ? (await import("@tauri-apps/plugin-http")).fetch : fetch;
}

/** One whole answer from the local model, made cool. Resolves with the thinking and the answer. */
export async function coolGenerate(o: CoolOptions): Promise<{ thinking: string; answer: string; tokens: number }> {
  const think = o.think !== false;
  const fetcher = await http();
  const base = chatml(o.messages, think);
  let thinking = "";
  let answer = "";
  let tokens = 0;
  let best = 0;
  for (;;) {
    const started = performance.now();
    // Ollama (0.40+) moves the thinking into its own field even in raw mode, so the text so far is
    // put back together here; once the answer has begun, thinking is off so it lands in `response`.
    const thinkingNow = think && !answer;
    const res = await fetcher(`${OLLAMA_URL}/api/generate`, {
      method: "POST",
      signal: o.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: o.model,
        prompt: base + continuation(thinking, answer, think),
        raw: true,
        stream: false,
        think: thinkingNow,
        keep_alive: "15m",
        options: { num_predict: o.level === "off" ? MAX_TOKENS - tokens : BURST, num_ctx: o.numCtx ?? 16384, stop: ["<|im_end|>", "<|im_start|>"] },
      }),
    });
    if (!res.ok) throw new Error(`The local model answered ${res.status}: ${(await res.text()).slice(0, 160)}`);
    const body = await res.json();
    ({ thinking, answer } = addBurst(thinking, answer, thinkingNow, body.thinking ?? "", body.response ?? ""));
    const count: number = body.eval_count ?? 0;
    tokens += count;
    const speed = body.eval_duration ? count / (body.eval_duration / 1e9) : 0;
    // The first bursts set the cool-chip speed; later ones are compared with it.
    if (count > BURST / 2) best = Math.max(best, speed);
    const finished = body.done_reason !== "length" || count === 0 || tokens >= MAX_TOKENS;
    const parts = { thinking: thinking.trim(), answer: answer.trim() };
    if (finished) {
      o.onProgress?.({ ...parts, restUntil: 0, speed, hot: false });
      return { ...parts, tokens };
    }
    const rest = restMs(o.level, performance.now() - started, speed, best);
    o.onProgress?.({ ...parts, restUntil: Date.now() + rest, speed, hot: best > 0 && speed < best * 0.8 });
    await sleep(rest, o.signal);
  }
}
