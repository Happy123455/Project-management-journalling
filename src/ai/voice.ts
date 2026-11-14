// 🎙️ Continuous voice recording with live transcription, for the voice graph (VoicePanel.tsx).
// The microphone goes two ways: a compressed recording of the whole talk (saved with the note),
// and 16 kHz pieces cut at pauses that are transcribed one after another while you talk. On the
// Mac, Whisper runs on the device (src-tauri/src/whisper.rs); on the phone, or when Whisper isn't
// downloaded, Gemini transcribes each piece. Silent pieces are dropped, so pauses cost nothing.
import { pickAudioType } from "../lib/capture";
import { holdAwake } from "../lib/power";
import { base64, downsample, pcm16, SpeechChunker, wavFile } from "../lib/wav";
import { geminiText } from "./decide";

export type Engine = "whisper" | "gemini";

/** The Mac app (the phone app has the Android bridges). */
export const onMac = () => "__TAURI_INTERNALS__" in window && !window.JournalSecrets && !window.JournalShare;

export interface WhisperInfo {
  models: { id: string; sizeMb: number; installed: boolean }[];
  model: string | null;
  downloading: string | null;
}

export async function whisperInfo(): Promise<WhisperInfo | null> {
  if (!onMac()) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<WhisperInfo>("whisper_info");
  } catch {
    // An older app build without Whisper.
    return null;
  }
}

/** The engine to use: Whisper on the Mac when a model is downloaded, else Gemini. */
export async function pickEngine(): Promise<Engine> {
  const info = await whisperInfo();
  return info?.model ? "whisper" : "gemini";
}

const TRANSCRIBE_MODELS = ["gemini-flash-lite-latest", "gemini-3.5-flash-lite", "gemini-flash-latest"];

/** One piece's words. `before`: the end of what was said just before (helps with cut words). */
export async function transcribe(engine: Engine, samples: Float32Array, before = "", fetchImpl?: typeof fetch): Promise<string> {
  if (engine === "whisper") {
    const { invoke } = await import("@tauri-apps/api/core");
    return clean(await invoke<string>("whisper_transcribe", pcm16(samples)));
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
}

/**
 * A running recording. `stop()` ends it and resolves when every piece is transcribed, with the
 * transcript and the whole recording as a file.
 */
export interface LiveRecording {
  stop(): Promise<{ text: string; audio: File | null; seconds: number; startedAt: Date }>;
  cancel(): void;
}

export async function startLive(onState: (s: LiveState) => void, engine0?: Engine): Promise<LiveRecording> {
  let engine = engine0 ?? (await pickEngine());
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  const startedAt = new Date();
  const release = holdAwake();
  const state: LiveState = { seconds: 0, level: 0, text: "", waiting: 0, engine };
  const emit = () => onState({ ...state });

  // The whole talk, compressed, to keep with the note.
  const type = pickAudioType((t) => MediaRecorder.isTypeSupported(t));
  const rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
  const blobs: Blob[] = [];
  rec.ondataavailable = (e) => e.data.size && blobs.push(e.data);
  rec.start(5000);

  // Pieces for transcription, one at a time, in order.
  const parts: string[] = [];
  let queue = Promise.resolve();
  let cancelled = false;
  const chunker = new SpeechChunker((piece) => {
    state.waiting++;
    emit();
    const index = parts.push("") - 1;
    queue = queue.then(async () => {
      if (cancelled) return;
      try {
        parts[index] = await transcribe(engine, piece, parts.slice(0, index).join(" "));
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
  });

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
    if (!onMac()) return;
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
