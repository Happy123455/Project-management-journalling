// Items 12 and 13: speech to text for the assistant and the talk box. On the phone, Android's own
// speech engine (MainActivity.kt ListenBridge: quick, free, words appear while talking); if it's
// missing or fails, the journal's recorder (ai/voice.ts: Whisper on the Mac, else Gemini).
import { startLive, type LiveRecording } from "../ai/voice";

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
