// 🎙️ Continuous voice recording with live transcription, for the voice graph (VoicePanel.tsx).
// The microphone goes two ways: a compressed recording of the whole talk (saved with the note),
// and 16 kHz pieces cut at pauses that are transcribed one after another while you talk. On the
// Mac, Whisper runs on the device (src-tauri/src/whisper.rs); on the phone, or when Whisper isn't
// downloaded, Gemini transcribes each piece. Silent pieces are dropped, so pauses cost nothing.
import { pickAudioType } from "../lib/capture";
import { holdAwake } from "../lib/power";
import { base64, downsample, pcm16, PauseChunker, SpeechChunker, wavFile } from "../lib/wav";
import { geminiText } from "./decide";

export type Engine = "whisper" | "gemini";

/** The Mac app (the phone app has the Android bridges). */
export const onMac = () => "__TAURI_INTERNALS__" in window && !window.JournalSecrets && !window.JournalShare;

export interface WhisperInfo {
  models: { id: string; sizeMb: number; installed: boolean }[];
  model: string | null;
  downloading: string | null;
  /** Why the last download failed. */
  error?: string | null;
}

/** The app, Mac or phone (not a plain browser): Whisper can run here. */
export const inApp = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export async function whisperInfo(): Promise<WhisperInfo | null> {
  if (!inApp()) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<WhisperInfo>("whisper_info");
  } catch {
    // An older app build without Whisper.
    return null;
  }
}

/** The engine to use: Whisper (Mac or phone) when a model is downloaded, else Gemini. */
export async function pickEngine(): Promise<Engine> {
  const info = await whisperInfo();
  return info?.model ? "whisper" : "gemini";
}

const TRANSCRIBE_MODELS = ["gemini-3.5-flash-lite", "gemini-flash-lite-latest", "gemini-3.1-flash-lite", "gemini-flash-latest"];

/** One piece's words. `before`: the end of what was said just before (helps with cut words). */
export async function transcribe(engine: Engine, samples: Float32Array, before = "", fetchImpl?: typeof fetch, lang = ""): Promise<string> {
  if (engine === "whisper") {
    const { invoke } = await import("@tauri-apps/api/core");
    // lang: "en", "gu", "hi"… or "" (Whisper guesses; on short sentences it can guess wrong).
    // The Mac takes the samples as raw bytes; the phone's bridge carries only JSON (base64 there).
    const body = onMac() ? pcm16(samples) : { pcm: base64(pcm16(samples)), lang };
    return clean(await invoke<string>("whisper_transcribe", body, { headers: { "x-lang": lang } }));
  }
  const { text } = await geminiText(
    TRANSCRIBE_MODELS,
    {
      systemInstruction: { parts: [{ text: "You transcribe speech. Write exactly the words spoken, in the language and script spoken, with normal punctuation. No notes, no timestamps, no speaker names. If there is no speech, answer with nothing." }] },
      contents: [{ role: "user", parts: [{ inlineData: { mimeType: "audio/wav", data: base64(wavFile(samples)) } }, { text: before ? `The words just before this piece: "…${before.slice(-160)}". Transcribe only this piece.` : "Transcribe this." }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 2048 },
    },
    fetchImpl,
    60_000,
    // No speech in this piece is a real answer.
    { allowEmpty: true },
  );
  return clean(text);
}

/** Whisper's and Gemini's ways of saying "nothing here". */
export function clean(t: string): string {
  const s = t.replace(/\s+/g, " ").trim();
  if (/^[([]?\s*(blank_audio|silence|no speech|music|inaudible|empty)\s*[)\]]?\.?$/i.test(s)) return "";
  return s;
}

/** The AudioWorklet that hands the microphone's samples to the page (a few times a second). */
const WORKLET = `class Tap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(16384); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      if (this.n + ch.length > this.buf.length) { this.port.postMessage(this.buf.slice(0, this.n)); this.n = 0; }
      this.buf.set(ch, this.n); this.n += ch.length;
    }
    return true;
  }
}
registerProcessor("journal-tap", Tap);`;

export interface LiveState {
  seconds: number;
  level: number;
  /** The transcript so far. */
  text: string;
  /** Pieces waiting for transcription. */
  waiting: number;
  engine: Engine;
  note?: string;
  /** Pieces with speech-like sound that came back as no words. */
  missed?: number;
  /** Live: the voice is louder than the room right now. */
  speaking?: boolean;
}

/**
 * A running recording. `stop()` ends it and resolves when every piece is transcribed, with the
 * transcript and the whole recording as a file.
 */
export interface LiveRecording {
  stop(): Promise<{ text: string; audio: File | null; seconds: number; startedAt: Date }>;
  cancel(): void;
}

/** The language live agents are spoken to in (Whisper): English unless journal.liveLang says ("" = guess). */
export function liveLang(): string {
  try {
    return localStorage.getItem("journal.liveLang") ?? "en";
  } catch {
    return "en";
  }
}

/**
 * The phone gets Whisper once (Hapi asked for it, 21 Nov: "the best speech to text… on my
 * mobile"): the base model (~200 MB) downloads in the background the first time anything
 * listens; Gemini transcribes until it's there.
 */
async function getWhisper(onNote?: (note: string) => void) {
  if (!inApp() || onMac()) return;
  const info = await whisperInfo();
  if (!info || info.model || info.downloading) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("download_whisper", { model: "base" });
    onNote?.("Getting Whisper for this phone (once, ~200 MB). Gemini listens until then.");
  } catch {
    // An app build without Whisper.
  }
}

/** live: cut at every pause (live agents), not every 12–24 s. lang: Whisper's language ("" = guess). */
export async function startLive(onState: (s: LiveState) => void, engine0?: Engine, live = false, lang0?: string): Promise<LiveRecording> {
  let engine = engine0 ?? (await pickEngine());
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  const startedAt = new Date();
  const release = holdAwake();
  const state: LiveState = { seconds: 0, level: 0, text: "", waiting: 0, engine };
  if (engine === "gemini") void getWhisper((note) => onState({ ...state, note }));
  const lang = lang0 ?? (live ? liveLang() : "");
  const emit = () => onState({ ...state });

  // The whole talk, compressed, to keep with the note.
  const type = pickAudioType((t) => MediaRecorder.isTypeSupported(t));
  const rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
  const blobs: Blob[] = [];
  rec.ondataavailable = (e) => e.data.size && blobs.push(e.data);
  // Live talk keeps no recording (it can run for an hour).
  if (!live) rec.start(5000);

  // Pieces for transcription, one at a time, in order.
  const parts: string[] = [];
  let queue = Promise.resolve();
  let cancelled = false;
  const onPiece = (piece: Float32Array) => {
    state.waiting++;
    emit();
    const index = parts.push("") - 1;
    queue = queue.then(async () => {
      if (cancelled) return;
      try {
        parts[index] = await transcribe(engine, piece, parts.slice(0, index).join(" "), undefined, lang);
        if (!parts[index]) state.missed = (state.missed ?? 0) + 1;
      } catch (e) {
        if (engine === "whisper") {
          // Whisper failed: the rest (and this piece) with Gemini.
          engine = state.engine = "gemini";
          state.note = `Whisper stopped (${e instanceof Error ? e.message : String(e)}); using Gemini.`;
          try {
            parts[index] = await transcribe(engine, piece, parts.slice(0, index).join(" "));
          } catch (e2) {
            state.note = `A piece couldn't be transcribed: ${e2 instanceof Error ? e2.message : String(e2)}`;
          }
        } else {
          state.note = `A piece couldn't be transcribed: ${e instanceof Error ? e.message : String(e)}`;
        }
      }
      state.waiting--;
      state.text = parts.filter(Boolean).join(" ");
      emit();
    });
  };
  // Live: a sentence goes at a pause, or after 8 s at most (a room that never goes quiet still gets answers).
  const chunker = live ? new PauseChunker(onPiece, 0.7, 0.012, 8) : new SpeechChunker(onPiece);

  const ctx = new AudioContext();
  const url = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
  await ctx.audioWorklet.addModule(url);
  URL.revokeObjectURL(url);
  const source = ctx.createMediaStreamSource(stream);
  const tap = new AudioWorkletNode(ctx, "journal-tap");
  // A silent output keeps the worklet running everywhere (some engines skip unconnected nodes).
  const mute = ctx.createGain();
  mute.gain.value = 0;
  source.connect(tap).connect(mute).connect(ctx.destination);
  let lastUi = 0;
  tap.port.onmessage = (e: MessageEvent<Float32Array>) => {
    const s = downsample(e.data, ctx.sampleRate);
    chunker.push(s);
    let peak = 0;
    for (let i = 0; i < s.length; i += 8) peak = Math.max(peak, Math.abs(s[i]));
    state.level = Math.max(peak, state.level * 0.7);
    if (chunker instanceof PauseChunker) state.speaking = chunker.speaking;
    state.seconds = (Date.now() - startedAt.getTime()) / 1000;
    // The meter and timer at most 4 times a second, and not at all off screen.
    const now = performance.now();
    if (now - lastUi > 250 && document.visibilityState === "visible") {
      lastUi = now;
      emit();
    }
  };

  const shutdown = async () => {
    tap.port.onmessage = null;
    source.disconnect();
    tap.disconnect();
    await ctx.close().catch(() => {});
    const done = new Promise<void>((ok) => {
      rec.onstop = () => ok();
      if (rec.state === "inactive") ok();
    });
    if (rec.state !== "inactive") rec.stop();
    await done;
    stream.getTracks().forEach((t) => t.stop());
    release();
  };
  const freeWhisper = async () => {
    if (!inApp()) return;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("whisper_release");
    } catch {
      // Nothing loaded.
    }
  };

  return {
    async stop() {
      chunker.flush();
      await shutdown();
      await queue;
      await freeWhisper();
      const mime = rec.mimeType.split(";")[0] || "audio/webm";
      const ext = mime.includes("mp4") ? "m4a" : mime.includes("ogg") ? "ogg" : "webm";
      const audio = blobs.length ? new File(blobs, `voice-graph-${startedAt.toISOString().replace(/[:.]/g, "-")}.${ext}`, { type: mime }) : null;
      return { text: parts.filter(Boolean).join(" "), audio, seconds: (Date.now() - startedAt.getTime()) / 1000, startedAt };
    },
    cancel() {
      cancelled = true;
      void shutdown().then(freeWhisper);
    },
  };
}

/**
 * A saved recording (a watch voice note, an audio file) in words with Whisper on the device:
 * decoded, 16 kHz mono, cut into ≤25 s pieces. Null when Whisper isn't here (the caller uses Gemini).
 */
export async function whisperFile(bytes: ArrayBuffer, lang = ""): Promise<string | null> {
  if ((await pickEngine()) !== "whisper") return null;
  const ctx = new AudioContext();
  try {
    const audio = await ctx.decodeAudioData(bytes.slice(0));
    const mono = new Float32Array(audio.length);
    for (let c = 0; c < audio.numberOfChannels; c++) {
      const ch = audio.getChannelData(c);
      for (let i = 0; i < ch.length; i++) mono[i] += ch[i] / audio.numberOfChannels;
    }
    const s = downsample(mono, audio.sampleRate);
    const step = 16_000 * 25;
    const parts: string[] = [];
    for (let i = 0; i < s.length; i += step) parts.push(await transcribe("whisper", s.subarray(i, i + step), parts.join(" "), undefined, lang));
    return parts.filter(Boolean).join(" ");
  } finally {
    void ctx.close().catch(() => {});
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("whisper_release");
    } catch {
      // Nothing loaded.
    }
  }
}

export interface PcmRecording {
  /** Ends it: all the 16 kHz samples. */
  stop(): Promise<Float32Array>;
  cancel(): void;
  seconds(): number;
}

/** Records the microphone as 16 kHz samples, nothing transcribed (the 📞 call sends the audio itself). */
export async function recordPcm(onLevel?: (level: number) => void): Promise<PcmRecording> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  const release = holdAwake();
  const ctx = new AudioContext();
  const url = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
  await ctx.audioWorklet.addModule(url);
  URL.revokeObjectURL(url);
  const source = ctx.createMediaStreamSource(stream);
  const tap = new AudioWorkletNode(ctx, "journal-tap");
  const mute = ctx.createGain();
  mute.gain.value = 0;
  source.connect(tap).connect(mute).connect(ctx.destination);
  const pieces: Float32Array[] = [];
  let n = 0;
  let level = 0;
  let lastUi = 0;
  tap.port.onmessage = (e: MessageEvent<Float32Array>) => {
    const s = downsample(e.data, ctx.sampleRate);
    pieces.push(s);
    n += s.length;
    let peak = 0;
    for (let i = 0; i < s.length; i += 8) peak = Math.max(peak, Math.abs(s[i]));
    level = Math.max(peak, level * 0.7);
    const now = performance.now();
    if (onLevel && now - lastUi > 120) {
      lastUi = now;
      onLevel(level);
    }
  };
  const shutdown = async () => {
    tap.port.onmessage = null;
    source.disconnect();
    tap.disconnect();
    await ctx.close().catch(() => {});
    stream.getTracks().forEach((t) => t.stop());
    release();
  };
  return {
    async stop() {
      await shutdown();
      const out = new Float32Array(n);
      let at = 0;
      for (const p of pieces) (out.set(p, at), (at += p.length));
      return out;
    },
    cancel: () => void shutdown(),
    seconds: () => n / 16_000,
  };
}
