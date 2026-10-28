/**
 * Read aloud: one player for the whole app. Android speaks through the native TextToSpeech
 * (MainActivity.kt SpeechBridge, best installed voice); the Mac through the WebView's speech
 * synthesis (AVSpeechSynthesizer voices). Pause = stop and remember where it was, so it works the
 * same on both and a speed change can pick up from the current word.
 */

declare global {
  interface Window {
    JournalSpeech?: {
      speak(text: string, rate: number, id: string): void;
      stop(): void;
      /** Kokoro voices (Android): JSON VoiceInfo. */
      voiceInfo?(): string;
      downloadVoice?(model: string): void;
      removeVoice?(model: string): void;
      setVoiceModel?(model: string): void;
      setVoice?(voice: number): void;
    };
    __journalVoiceProgress?: (p: VoiceProgress) => void;
    __journalSpeech?: (event: "range" | "done" | "error", id: string, index?: number) => void;
  }
}

export interface VoiceInfo {
  models: { id: string; sizeMb: number; installed: boolean }[];
  model: string;
  voice: number;
  downloading: string | null;
  /** Voices in the loaded model (0 until it has spoken once). */
  speakers: number;
}
export interface VoiceProgress {
  model: string;
  state: "downloading" | "done" | "error";
  received: number;
  total: number;
  message: string;
}

/** Kokoro model names as shown in Settings. */
export const MODEL_NAMES: Record<string, string> = {
  "kokoro-int8-en-v0_19": "Kokoro English",
  "kokoro-int8-multi-lang-v1_1": "Kokoro multi-language (incl. Hindi)",
};
/** The English model's voices, in speaker-id order. */
export const KOKORO_EN_VOICES = [
  "Default (US)", "Bella (US)", "Nicole (US)", "Sarah (US)", "Sky (US)",
  "Adam (US)", "Michael (US)", "Emma (UK)", "Isabella (UK)", "George (UK)", "Lewis (UK)",
];

export function voiceInfo(): VoiceInfo | null {
  const raw = window.JournalSpeech?.voiceInfo?.();
  return raw ? (JSON.parse(raw) as VoiceInfo) : null;
}

export type ReadStatus = "idle" | "playing" | "paused";
export interface ReadState {
  status: ReadStatus;
  rate: number;
}

export const RATES = [0.75, 1, 1.25, 1.5, 2];
const RATE_KEY = "dynamic-journal.read-rate";

function savedRate(): number {
  try {
    const r = Number(localStorage.getItem(RATE_KEY));
    return RATES.includes(r) ? r : 1;
  } catch {
    return 1;
  }
}

let state: ReadState = { status: "idle", rate: savedRate() };
let text = "";
/** Where the current run started in `text`, and the last word reached. */
let base = 0;
let reached = 0;
/** Each run gets a new id; events from a stopped run are ignored. */
let run = 0;
const listeners = new Set<(s: ReadState) => void>();

function set(patch: Partial<ReadState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l(state));
}

export function subscribeReadAloud(listener: (s: ReadState) => void): () => void {
  listeners.add(listener);
  listener(state);
  return () => {
    listeners.delete(listener);
  };
}

/** The best voice for the page language: Premium, then Enhanced (Siri-quality), then any local one. */
function bestWebVoice(): SpeechSynthesisVoice | null {
  const lang = (navigator.language || "en").toLowerCase();
  const voices = window.speechSynthesis.getVoices().filter((v) => v.lang.toLowerCase().startsWith(lang.slice(0, 2)));
  const score = (v: SpeechSynthesisVoice) =>
    (/premium/i.test(v.name) ? 8 : 0) + (/enhanced|siri/i.test(v.name) ? 4 : 0) + (v.lang.toLowerCase() === lang ? 2 : 0) + (v.localService ? 1 : 0);
  return voices.sort((a, b) => score(b) - score(a))[0] ?? null;
}

const engineStop = () => {
  if (window.JournalSpeech) window.JournalSpeech.stop();
  else window.speechSynthesis?.cancel();
};

function start() {
  const id = String(++run);
  const from = base;
  const part = text.slice(from);
  const onRange = (i: number) => {
    if (id === String(run)) reached = from + i;
  };
  const onDone = () => {
    if (id === String(run) && state.status === "playing") set({ status: "idle" });
  };
  if (window.JournalSpeech) {
    window.__journalSpeech = (event, eventId, index) => {
      if (eventId !== String(run)) return;
      if (event === "range") onRange(index ?? 0);
      else onDone();
    };
    window.JournalSpeech.speak(part, state.rate, id);
    return;
  }
  const synth = window.speechSynthesis;
  if (!synth) return set({ status: "idle" });
  const u = new SpeechSynthesisUtterance(part);
  const voice = bestWebVoice();
  if (voice) u.voice = voice;
  u.rate = state.rate;
  u.onboundary = (e) => onRange(e.charIndex);
  u.onend = onDone;
  u.onerror = onDone;
  synth.cancel();
  synth.speak(u);
}

/** Starts reading `words` from the beginning (stops anything already playing). */
export function readAloud(words: string) {
  const clean = words.replace(/\s+\n/g, "\n").trim();
  if (!clean) return;
  run++;
  engineStop();
  text = clean;
  base = reached = 0;
  set({ status: "playing" });
  start();
}

export function pauseReading() {
  if (state.status !== "playing") return;
  run++;
  engineStop();
  // Back to the start of the word it was on.
  base = reached;
  set({ status: "paused" });
}

export function resumeReading() {
  if (state.status !== "paused") return;
  set({ status: "playing" });
  start();
}

export function stopReading() {
  run++;
  engineStop();
  set({ status: "idle" });
}

export function setReadRate(rate: number) {
  try {
    localStorage.setItem(RATE_KEY, String(rate));
  } catch {
    // Only a convenience.
  }
  set({ rate });
  if (state.status === "playing") {
    run++;
    engineStop();
    base = reached;
    start();
  }
}

export const canReadAloud = () => !!window.JournalSpeech || "speechSynthesis" in window;

// Mac voices load after start-up; asking once makes them available for the first read.
if (typeof window !== "undefined" && window.speechSynthesis) window.speechSynthesis.getVoices();
