// The one voice-graph recording, kept outside any screen: closing AI chat doesn't stop it (a
// 🎙️ badge stays at the top), and when it ends the talk is saved to today's note first (so the
// words are never lost), then turned into the graph.
import type { JournalStore } from "../store";
import { mediaNode } from "../editor/attachments";
import { appendBlocks } from "../lib/append";
import { formatDuration } from "../lib/capture";
import { dayKey } from "../lib/timestamp";
import { showBackgroundToast } from "../lib/toast";
import { docText } from "../lib/words";
import { startLive, type Engine, type LiveRecording, type LiveState } from "./voice";
import { buildVoiceGraph, type VoiceGraphResult } from "./voiceGraph";

export type VoicePhase = "idle" | "starting" | "recording" | "finishing" | "building" | "done" | "error";

export interface VoiceSession {
  phase: VoicePhase;
  name: string;
  live: LiveState | null;
  result?: VoiceGraphResult;
  /** The talk, once it's saved (kept when the graph couldn't be made). */
  transcript?: string;
  error?: string;
}

let session: VoiceSession = { phase: "idle", name: "", live: null };
let rec: LiveRecording | null = null;
const listeners = new Set<() => void>();
const set = (next: Partial<VoiceSession>) => {
  session = { ...session, ...next };
  listeners.forEach((l) => l());
};

export const voiceSession = () => session;
export function subscribeVoice(l: () => void) {
  listeners.add(l);
  return () => void listeners.delete(l);
}
/** Panels showing the session (the badge hides while one is open). */
let shown = 0;
export function showingVoice(): () => void {
  shown++;
  listeners.forEach((l) => l());
  return () => {
    shown--;
    listeners.forEach((l) => l());
  };
}
export const voicePanelOpen = () => shown > 0;

export const recordingVoice = () => session.phase === "recording" || session.phase === "starting" || session.phase === "finishing";

export async function startVoice(name: string, engine?: Engine) {
  if (recordingVoice() || session.phase === "building") return;
  set({ phase: "starting", name, live: null, result: undefined, transcript: undefined, error: undefined });
  try {
    rec = await startLive((live) => set({ live }), engine);
    set({ phase: "recording" });
  } catch (e) {
    rec = null;
    set({ phase: "error", error: e instanceof Error && e.name === "NotAllowedError" ? "The microphone isn't allowed for the app." : e instanceof Error ? e.message : String(e) });
  }
}

export function cancelVoice() {
  rec?.cancel();
  rec = null;
  set({ phase: "idle", live: null });
}

/** Ends the recording: saves the talk to today's note, then builds the graph. */
export async function finishVoice(store: JournalStore, onChanged?: () => void) {
  if (!rec || session.phase !== "recording") return;
  const r = rec;
  rec = null;
  set({ phase: "finishing" });
  const { text, audio, seconds, startedAt } = await r.stop();
  const name = session.name.trim() || "Voice";
  if (!text) {
    set({ phase: "error", error: "No words came through (only silence?). Nothing was saved." });
    return;
  }
  // 1. The words and the recording go in today's note, before anything that could fail.
  try {
    await window.__journalFlush?.();
    const day = dayKey(startedAt);
    const note = await store.getDay(day);
    const file = audio ? await store.saveFile({ name: audio.name, mime: audio.type, bytes: new Uint8Array(await audio.arrayBuffer()), actor: "me" }) : null;
    const blocks = [
      { type: "paragraph", content: [{ type: "text", text: `🎙️ [[Graph · ${name}]] · ${formatDuration(seconds)}` }] },
      ...(file ? [{ type: "paragraph", content: [mediaNode(file)] }] : []),
      { type: "paragraph", content: [{ type: "text", text }] },
    ];
    const doc = appendBlocks(note?.content ?? null, blocks);
    await store.saveDay({ day, content: doc, plainText: docText(doc), actor: "me" });
    window.dispatchEvent(new Event("journal:reload-page"));
    onChanged?.();
  } catch (e) {
    // Still keep the words on screen to copy.
    set({ phase: "error", transcript: text, error: `Couldn't save the talk: ${e instanceof Error ? e.message : String(e)}` });
    return;
  }
  // 2. The graph.
  set({ phase: "building", transcript: text });
  try {
    const result = await buildVoiceGraph(store, { name, transcript: text, at: startedAt });
    set({ phase: "done", result });
    onChanged?.();
    showBackgroundToast(`🎙️ "${name}" graph: ${result.ideas} idea${result.ideas === 1 ? "" : "s"}${result.newBranches.length ? `, new branches: ${result.newBranches.join(", ")}` : ""}`);
  } catch (e) {
    set({ phase: "error", error: `The talk is saved in today's note, but the graph couldn't be made: ${e instanceof Error ? e.message : String(e)}` });
  }
}

export function resetVoice() {
  if (recordingVoice() || session.phase === "building") return;
  set({ phase: "idle", live: null, result: undefined, transcript: undefined, error: undefined });
}
