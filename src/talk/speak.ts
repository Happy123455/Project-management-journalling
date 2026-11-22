// The interviewer's and the call's voice. English: the journal's read-aloud voice (Kokoro / the
// system voice). Gujarati: Google's Gujarati voice on the phone (MainActivity.kt speakLang); on
// the Mac (no Gujarati voice) or when the phone has none, Gemini's own voice.
import { readAloud, stopReading, subscribeReadAloud } from "../lib/readAloud";
import { geminiCall } from "../ai/gemini";
import { getKey } from "../ai/secrets";

let audio: { ctx: AudioContext; src: AudioBufferSourceNode } | null = null;
let gen = 0;
/** Ends a wait on the phone's voice (a stopped voice sends no "done"). */
let cutWait: (() => void) | null = null;

/** Stops whatever is being said. */
export function stopSpeaking() {
  gen++;
  cutWait?.();
  cutWait = null;
  stopReading();
  try {
    audio?.src.stop();
  } catch {
    // Already stopped.
  }
  void audio?.ctx.close().catch(() => {});
  audio = null;
}

/** Says English text; resolves when it's done (or stopped). */
export function speakEnglish(text: string): Promise<void> {
  stopSpeaking();
  return new Promise((done) => {
    let started = false;
    const off = subscribeReadAloud((s) => {
      if (s.status === "playing") started = true;
      else if (started && s.status === "idle") (off(), done());
    });
    readAloud(text);
    // Nothing to read with: don't wait for ever.
    window.setTimeout(() => !started && (off(), done()), 4000);
  });
}

const TTS_MODELS = ["gemini-2.5-flash-preview-tts", "gemini-2.5-flash-tts", "gemini-2.5-pro-preview-tts"];

/** Gemini's voice: 24 kHz PCM, played here. False when it couldn't. */
async function geminiSpeak(text: string, my: number): Promise<boolean> {
  const key = await getKey("gemini");
  if (!key) return false;
  try {
    const r = await geminiCall({
      key,
      model: TTS_MODELS[0],
      chain: TTS_MODELS,
      allowEmpty: true,
      quiet: true,
      retryForMs: 20_000,
      fastTimeoutMs: 40_000,
      body: () => ({
        contents: [{ parts: [{ text: `Say this in warm, natural spoken Gujarati, like a friend on a call:\n${text}` }] }],
        generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } } } },
      }),
    });
    const part = r.json.candidates?.[0]?.content?.parts?.find((p) => (p as { inlineData?: unknown }).inlineData) as { inlineData?: { data: string; mimeType?: string } } | undefined;
    if (!part?.inlineData?.data || my !== gen) return my !== gen;
    const rate = Number(/rate=(\d+)/.exec(part.inlineData.mimeType ?? "")?.[1]) || 24_000;
    const bytes = Uint8Array.from(atob(part.inlineData.data), (c) => c.charCodeAt(0));
    const view = new DataView(bytes.buffer);
    const samples = new Float32Array(bytes.length >> 1);
    for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
    const ctx = new AudioContext();
    const buf = ctx.createBuffer(1, samples.length, rate);
    buf.copyToChannel(samples, 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    audio = { ctx, src };
    await new Promise<void>((ok) => {
      src.onended = () => ok();
      src.start();
    });
    if (audio?.src === src) {
      void ctx.close().catch(() => {});
      audio = null;
    }
    return true;
  } catch {
    return false;
  }
}

/** Says Gujarati text; resolves when it's done (or stopped, or nothing could say it). */
export async function speakGujarati(text: string): Promise<void> {
  stopSpeaking();
  const my = gen;
  const bridge = window.JournalSpeech;
  if (bridge?.speakLang) {
    const id = `gu${my}`;
    const res = await new Promise<"done" | "error" | "none">((ok) => {
      const prev = window.__journalSpeech;
      const finish = (r: "done" | "error" | "none") => {
        if (window.__journalSpeech === on) window.__journalSpeech = prev;
        ok(r);
      };
      const on: typeof window.__journalSpeech = (event, eventId) => {
        if (eventId !== id) return prev?.(event, eventId);
        if (event === "done") finish("done");
        else if (event === "error") finish("error");
      };
      window.__journalSpeech = on;
      cutWait = () => finish("done");
      if (!bridge.speakLang!(text, 1, id, "gu-IN")) finish("none");
    });
    if (res === "done" || my !== gen) return;
  }
  if (await geminiSpeak(text, my)) return;
  // Last: a Gujarati voice in the system, if any (the Mac usually has none).
  const synth = window.speechSynthesis;
  const voice = synth?.getVoices().find((v) => v.lang.toLowerCase().startsWith("gu"));
  if (!voice || my !== gen) return;
  await new Promise<void>((ok) => {
    const u = new SpeechSynthesisUtterance(text);
    u.voice = voice;
    u.onend = u.onerror = () => ok();
    synth.speak(u);
  });
}
