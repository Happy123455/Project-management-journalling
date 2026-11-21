// Items 12 and 13: speech to text for the assistant and the talk box. On the phone, Android's own
// speech engine (MainActivity.kt ListenBridge: quick, free, words appear while talking); if it's
// missing or fails, the journal's recorder (ai/voice.ts: Whisper on the Mac, else Gemini).
import { inApp, onMac, startLive, whisperInfo, type LiveRecording } from "../ai/voice";

declare global {
  interface Window {
    /** Android: SpeechRecognizer (MainActivity.kt). Results come as "journal:listen" events. */
    JournalListen?: {
      available(): boolean;
      start(id: string, lang: string): void;
      stop(): void;
      cancel(): void;
    };
  }
}

export interface Listening {
  /** Stops listening; resolves with all that was said. */
  stop(): Promise<string>;
  cancel(): void;
  engine: "android" | "recorder";
}

type ListenDetail = { id: string; kind: "partial" | "final" | "error" | "end"; text?: string; error?: string };

export const canListen = () => !!window.JournalListen?.available?.() || (typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia);

/**
 * Starts listening. `onText` gets the words so far (with the part still being heard). Android's
 * engine stops at a pause, so it's started again until stop() (a long talk keeps going).
 */
export async function startListening(onText: (text: string) => void, onNote?: (note: string) => void): Promise<Listening> {
  const bridge = window.JournalListen;
  if (bridge?.available?.()) {
    try {
      return androidListen(bridge, onText, onNote);
    } catch {
      // Fall through to the recorder.
    }
  }
  let rec: LiveRecording | null = await startLive((s) => {
    onText(s.text);
    if (s.note) onNote?.(s.note);
  });
  return {
    engine: "recorder",
    stop: async () => {
      const r = await rec!.stop();
      rec = null;
      return r.text;
    },
    cancel: () => rec?.cancel(),
  };
}

function androidListen(bridge: NonNullable<Window["JournalListen"]>, onText: (t: string) => void, onNote?: (n: string) => void): Listening {
  const id = `l${Date.now().toString(36)}`;
  const said: string[] = [];
  let partial = "";
  let stopping = false;
  let finish: ((t: string) => void) | null = null;
  const all = () => [...said, partial].filter(Boolean).join(" ").trim();
  const lang = navigator.language || "en-IN";
  const on = (e: Event) => {
    const d = (e as CustomEvent<ListenDetail>).detail;
    if (!d || d.id !== id) return;
    if (d.kind === "partial") partial = d.text ?? "";
    else if (d.kind === "final") {
      if (d.text) said.push(d.text);
      partial = "";
    } else if (d.kind === "error" && d.error && !/no.?match|speech.?timeout/i.test(d.error)) onNote?.(d.error);
    onText(all());
    if (d.kind === "end" || d.kind === "error") {
      // A pause ended it: keep listening until stop() (unless it can't hear at all).
      if (stopping || (d.kind === "error" && /permission|insufficient|not.?available/i.test(d.error ?? ""))) {
        window.removeEventListener("journal:listen", on);
        finish?.(all());
      } else bridge.start(id, lang);
    }
  };
  window.addEventListener("journal:listen", on);
  bridge.start(id, lang);
  return {
    engine: "android",
    stop: () =>
      new Promise<string>((resolve) => {
        stopping = true;
        finish = resolve;
        bridge.stop();
        // The engine may not answer a stop when it was between starts.
        window.setTimeout(() => {
          window.removeEventListener("journal:listen", on);
          resolve(all());
        }, 1500);
      }),
    cancel: () => {
      stopping = true;
      window.removeEventListener("journal:listen", on);
      bridge.cancel();
    },
  };
}

export interface LiveEar {
  stop(): void;
  engine: "android" | "recorder";
}

/**
 * Live listening (agent bubbles): keeps listening until stop(), and hands over each sentence as
 * soon as it's finished (a pause), while `onHeard` shows the words still coming.
 */
export async function listenLive(
  onSentence: (text: string) => void,
  onHeard: (text: string) => void,
  onNote?: (note: string) => void,
  onLevel?: (level: number) => void,
): Promise<LiveEar> {
  // Android's own engine misheard words and kept failing with "error 11" (server disconnected)
  // between sentences (Hapi, 21 Nov). Live talk now records and transcribes each sentence with
  // Whisper on the device (Mac or phone; Gemini until it's downloaded); journal.liveEar = "android"
  // brings the old engine back.
  let useAndroid = false;
  try {
    useAndroid = localStorage.getItem("journal.liveEar") === "android";
  } catch {
    // No storage.
  }
  const bridge = window.JournalListen;
  if (!useAndroid && bridge?.available?.()) {
    // The microphone may be refused to the page: then Android's engine after all.
    try {
      return await recorderLive(onSentence, onHeard, onNote, onLevel);
    } catch (e) {
      onNote?.(`Recorder unavailable (${e instanceof Error ? e.message : String(e)}); using Android's listening.`);
      useAndroid = true;
    }
  }
  if (useAndroid && bridge?.available?.()) {
    const id = `v${Date.now().toString(36)}`;
    let stopped = false;
    const lang = navigator.language || "en-IN";
    const on = (e: Event) => {
      const d = (e as CustomEvent<ListenDetail>).detail;
      if (!d || d.id !== id || stopped) return;
      if (d.kind === "partial") onHeard(d.text ?? "");
      else if (d.kind === "final") {
        onHeard("");
        if (d.text?.trim()) onSentence(d.text.trim());
      } else if (d.kind === "error" && d.error && !/no.?match|speech.?timeout|busy|client/i.test(d.error)) onNote?.(d.error);
      if (d.kind === "end" || d.kind === "error") {
        if (d.kind === "error" && /permission|insufficient|not.?available/i.test(d.error ?? "")) {
          stopped = true;
          window.removeEventListener("journal:listen", on);
          return;
        }
        // A pause ended it: listen again for the next sentence.
        window.setTimeout(() => !stopped && bridge.start(id, lang), 120);
      }
    };
    window.addEventListener("journal:listen", on);
    bridge.start(id, lang);
    return {
      engine: "android",
      stop: () => {
        stopped = true;
        window.removeEventListener("journal:listen", on);
        bridge.cancel();
      },
    };
  }
  return recorderLive(onSentence, onHeard, onNote, onLevel);
}

/**
 * The phone gets Whisper once (Hapi asked for it, 21 Nov: "the best speech to text… on my
 * mobile"): the base model (~200 MB) downloads in the background the first time a bubble listens;
 * Gemini transcribes until it's there.
 */
async function getWhisper(onNote?: (note: string) => void) {
  if (!inApp() || onMac()) return;
  const info = await whisperInfo();
  if (!info || info.model || info.downloading) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("download_whisper", { model: "base" });
    onNote?.(info.error ? `Whisper download failed last time (${info.error}); trying again. Gemini listens meanwhile.` : "Getting Whisper for this phone (once, ~200 MB). Gemini listens until then.");
  } catch {
    // An app build without Whisper.
  }
}

async function recorderLive(onSentence: (text: string) => void, onHeard: (text: string) => void, onNote?: (note: string) => void, onLevel?: (level: number) => void): Promise<LiveEar> {
  void getWhisper(onNote);
  // The recorder (Whisper on the Mac, Gemini on the phone): it cuts at pauses; each new piece of text is a sentence once
  // nothing is waiting and nothing new came for a moment.
  let sent = 0;
  let timer = 0;
  let latest = "";
  const flush = () => {
    const fresh = latest.slice(sent).trim();
    sent = latest.length;
    if (fresh) onSentence(fresh);
  };
  let note = "";
  let missed = 0;
  const rec = await startLive((s) => {
    if (s.note && s.note !== note) onNote?.((note = s.note));
    if (s.text.length > latest.length) latest = s.text;
    onLevel?.(s.level);
    // What it's doing, always in sight (Hapi, 21 Nov: "I can't see if it's detecting anything").
    if ((s.missed ?? 0) > missed) {
      missed = s.missed ?? 0;
      onNote?.("Heard something but no words: say it again, a bit closer?");
    }
    onHeard(s.waiting ? `✍️ Writing down… (${s.engine === "whisper" ? "Whisper" : "Gemini"})` : s.speaking ? "🎙️ Hearing you…" : "");
    window.clearTimeout(timer);
    if (!s.waiting && latest.length > sent) timer = window.setTimeout(flush, 250);
  }, undefined, true);
  return {
    engine: "recorder",
    stop: () => {
      window.clearTimeout(timer);
      void rec.stop().then((r) => {
        latest = r.text.length > latest.length ? r.text : latest;
        flush();
      });
    },
  };
}
