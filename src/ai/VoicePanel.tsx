import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { JournalStore } from "../store";
import { formatDuration } from "../lib/capture";
import { showError } from "../lib/toast";
import { onMac, whisperInfo, type WhisperInfo } from "./voice";
import { graphNames } from "./voiceGraph";
import { cancelVoice, finishVoice, recordingVoice, resetVoice, showingVoice, startVoice, subscribeVoice, voicePanelOpen, voiceSession } from "./voiceSession";

const NAME_KEY = "dynamic-journal.voice-graph-name";
const remembered = () => {
  try {
    return localStorage.getItem(NAME_KEY) ?? "";
  } catch {
    return "";
  }
};

export const useVoiceSession = () => useSyncExternalStore(subscribeVoice, voiceSession);

/** Opens the mind map on a graph (App listens). */
export const openGraphInMindMap = (name: string) => window.dispatchEvent(new CustomEvent("journal:open-mind-map", { detail: { graph: name } }));

/** The Mac's Whisper: which model, or a button to download one. */
function WhisperRow() {
  const [info, setInfo] = useState<WhisperInfo | null>(null);
  const [progress, setProgress] = useState("");
  useEffect(() => {
    if (!onMac()) return;
    let live = true;
    let off = () => {};
    void whisperInfo().then((i) => live && setInfo(i));
    void import("@tauri-apps/api/event").then(({ listen }) =>
      listen<{ state: string; received: number; total: number; message: string }>("whisper-progress", (e) => {
        const p = e.payload;
        if (p.state === "downloading") setProgress(`Downloading ${Math.round(p.received / 1e6)}${p.total ? ` of ${Math.round(p.total / 1e6)}` : ""} MB…`);
        else {
          setProgress(p.state === "error" ? `Download failed: ${p.message}` : "");
          void whisperInfo().then((i) => live && setInfo(i));
        }
      }).then((u) => (live ? (off = u) : u())),
    );
    return () => {
      live = false;
      off();
    };
  }, []);
  if (!onMac() || !info) return <p className="hint">☁️ Transcribed by Gemini as you talk (silences aren't sent).</p>;
  if (info.model) return <p className="hint">🖥️ Whisper ({info.model}) transcribes on this Mac: the audio never leaves it.</p>;
  const base = info.models.find((m) => m.id === "base");
  const download = async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("download_whisper", { model: "base" });
      setProgress("Starting the download…");
    } catch (e) {
      showError("Couldn't download Whisper", e);
    }
  };
  return (
    <p className="hint">
      ☁️ Gemini transcribes for now.{" "}
      {progress || info.downloading ? (
        progress || "Downloading Whisper…"
      ) : (
        <button type="button" className="ai-save" onClick={() => void download()}>
          ⬇ Whisper on this Mac ({base?.sizeMb ?? 208} MB, once)
        </button>
      )}
    </p>
  );
}

/** 🎙️ Talk, watch the words appear, and get a structured graph of what you said. */
export function VoicePanel({ store, onClose, onChanged }: { store: JournalStore; onClose: () => void; onChanged: () => void }) {
  const s = useVoiceSession();
  const [name, setName] = useState(() => s.name || remembered());
  const [graphs, setGraphs] = useState<string[]>([]);
  const words = useRef<HTMLDivElement>(null);
  useEffect(showingVoice, []);
  useEffect(() => {
    void graphNames(store).then(setGraphs, () => {});
  }, [store, s.phase]);
  // The newest words stay in view.
  useEffect(() => {
    const el = words.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [s.live?.text]);

  const busy = recordingVoice() || s.phase === "building";
  const start = () => {
    const n = name.trim() || "Voice";
    try {
      localStorage.setItem(NAME_KEY, n);
    } catch {
      // Only a convenience.
    }
    void startVoice(n);
  };
  const live = s.live;
  const level = Math.min(1, (live?.level ?? 0) * 3);

  return (
    <div className="ai-section vg">
      <div className="ai-chat-bar">
        <input value={name} list="vg-graphs" placeholder="Graph name (new or existing)" onChange={(e) => setName(e.target.value)} disabled={busy} aria-label="Graph" />
        <datalist id="vg-graphs">
          {graphs.map((g) => (
            <option key={g} value={g} />
          ))}
        </datalist>
        <button type="button" onClick={onClose} aria-label="Close" title={busy ? "Keeps recording; the 🎙️ at the top brings you back" : "Close"}>
          ✕
        </button>
      </div>
      <WhisperRow />
      <div ref={words} className="vg-words">
        {s.phase === "idle" && !s.transcript && (
          <p className="hint">
            Talk about a project as long as you like. The words appear as you go; when you stop, they go in today's note with the recording, and the ideas are sorted onto a graph's branches
            {graphs.includes(name.trim()) ? ` (added to "${name.trim()}")` : ""}. The ⚖️ decision models choose the branches.
          </p>
        )}
        {(live?.text || s.transcript) && <p className="vg-text">{s.transcript ?? live?.text}</p>}
        {s.phase === "recording" && live && live.waiting > 0 && <p className="hint">Transcribing… {live.waiting > 1 ? `(${live.waiting} pieces waiting)` : ""}</p>}
        {live?.note && <p className="hint">{live.note}</p>}
        {s.phase === "error" && <p className="vg-error">{s.error}</p>}
        {s.phase === "done" && s.result && (
          <div className="vg-done">
            <strong>
              ✓ {s.result.ideas} idea{s.result.ideas === 1 ? "" : "s"} on "{s.result.title.replace(/^Graph · /, "")}"
            </strong>
            {s.result.newBranches.length > 0 && <span className="hint">New branches: {s.result.newBranches.join(", ")}</span>}
            <span className="hint">Also in any note's Canvas, in its graph menu.</span>
          </div>
        )}
      </div>
      <div className="vg-controls">
        {s.phase === "recording" || s.phase === "starting" ? (
          <>
            <span className="vg-meter" aria-hidden="true">
              <span style={{ transform: `scaleX(${level.toFixed(3)})` }} />
            </span>
            <span className="vg-time">● {formatDuration(live?.seconds ?? 0)}</span>
            <button type="button" className="vg-stop" disabled={s.phase !== "recording"} onClick={() => void finishVoice(store, onChanged)}>
              ⏹ Stop & make graph
            </button>
            <button type="button" onClick={cancelVoice} title="Throw this recording away">
              🗑
            </button>
          </>
        ) : s.phase === "finishing" || s.phase === "building" ? (
          <span className="hint">{s.phase === "finishing" ? "Finishing the words…" : "Sorting ideas onto branches…"}</span>
        ) : (
          <>
            <button type="button" className="vg-rec" onClick={start}>
              🎙️ {s.phase === "done" ? "Talk again" : "Start talking"}
            </button>
            {s.phase === "done" && s.result && (
              <button type="button" onClick={() => openGraphInMindMap(s.result!.title.replace(/^Graph · /, ""))}>
                🧠 Open
              </button>
            )}
            {(s.phase === "done" || s.phase === "error") && (
              <button type="button" onClick={resetVoice} aria-label="Clear">
                ↺
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** The 🎙️ pill at the top while a voice graph records with AI chat closed. */
export function VoiceBadge({ onOpen }: { onOpen: () => void }) {
  const s = useVoiceSession();
  const panel = useSyncExternalStore(subscribeVoice, voicePanelOpen);
  if (panel || (!recordingVoice() && s.phase !== "building")) return null;
  return (
    <button type="button" className="vg-badge" onClick={onOpen}>
      <span className="vg-dot" />
      {s.phase === "building" ? "Making the graph…" : `🎙️ ${formatDuration(s.live?.seconds ?? 0)}`}
    </button>
  );
}
