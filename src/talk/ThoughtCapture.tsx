// 💭 Quick thought (Hapi's handwritten note, 25 Nov): "a shortcut to record my ongoing thoughts:
// double press or hold the side button, record what I say, speech to text with the Whisper model,
// and a pop-up to pick which project block today the text goes in."
//
// Phone: the "Quick thought" launcher entry (Android activity-alias) is what Samsung's Side key →
// Double press → Open app points at; long-press the app icon has it too. Mac: ⌘⇧T in the app.
// It starts recording at once; Stop → Whisper → pick the block → the line goes under it.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { JSONContent } from "@tiptap/react";
import type { JournalStore } from "../store";
import { startListening, type Listening } from "../assistant/listen";
import { haptic } from "../lib/haptic";
import { dayKey, formatTimestamp } from "../lib/timestamp";
import { withLogLine } from "../lib/routine";
import { insertLogLinePM } from "../editor/noteEdit";
import { changeDay } from "../routine/routineData";
import { countsTowardsLimit } from "../lib/projects";
import { showError, showToast } from "../lib/toast";
import { useEscapeToClose } from "../ui/useEscapeToClose";
import { VoicePill } from "./VoicePill";

export const OPEN_THOUGHT = "journal:thought";
const ACTOR = "Quick thought";

/** "[[Name]]" lines standing alone at the top level of a note = its blocks, in order. */
export function blocksIn(doc: JSONContent | null | undefined): string[] {
  const out: string[] = [];
  const textOf = (b: JSONContent): string => (b.text ?? "") + (b.content ?? []).map(textOf).join("");
  for (const b of doc?.content ?? []) {
    if (b.type !== "paragraph" || Number(b.attrs?.indent ?? 0) > 0) continue;
    const m = /^\s*\[\[([^\]|]+)(?:\|[^\]]*)?\]\]\s*$/.exec(textOf(b));
    if (m && !out.includes(m[1].trim())) out.push(m[1].trim());
  }
  return out;
}

type Phase = "listening" | "writing" | "pick" | "failed";

export function ThoughtCapture({ store, onClose }: { store: JournalStore; onClose: () => void }) {
  const [phase, setPhase] = useState<Phase>("listening");
  const [text, setText] = useState("");
  const [note, setNote] = useState("");
  const [secs, setSecs] = useState(0);
  const [choices, setChoices] = useState<{ name: string; today: boolean }[]>([]);
  const lvl = useRef(0);
  const ear = useRef<Listening | null>(null);
  const day = useRef(dayKey(new Date()));
  const at = useRef(new Date());

  useEffect(() => {
    let live = true;
    haptic("press", 0.6);
    startListening((t) => live && setText(t), (n) => live && setNote(n), { onLevel: (l) => (lvl.current = l) })
      .then((l) => (live ? (ear.current = l) : l.cancel()))
      .catch((e) => (setNote(`Can't use the microphone: ${e instanceof Error ? e.message : String(e)}`), setPhase("failed")));
    // The blocks to offer: today's [[…]] blocks first, then active projects.
    void (async () => {
      const page = await store.getDay(day.current).catch(() => null);
      const today = blocksIn(page?.content);
      const projects = (await store.projects().catch(() => [])).filter(countsTowardsLimit).map((p) => p.title);
      if (live) setChoices([...today.map((name) => ({ name, today: true })), ...projects.filter((p) => !today.some((t) => t.toLowerCase() === p.toLowerCase())).map((name) => ({ name, today: false }))]);
    })();
    const t0 = Date.now();
    const id = window.setInterval(() => setSecs(Math.floor((Date.now() - t0) / 1000)), 1000);
    return () => {
      live = false;
      window.clearInterval(id);
      ear.current?.cancel();
    };
  }, [store]);

  const stop = async () => {
    const l = ear.current;
    ear.current = null;
    setPhase("writing");
    haptic("tick", 0.6);
    try {
      const t = ((await l?.stop()) ?? text).trim();
      if (!t) return setNote("Didn't catch any words."), setPhase("failed");
      setText(t);
      setPhase("pick");
    } catch (e) {
      setNote(`Couldn't write it down: ${e instanceof Error ? e.message : String(e)}`);
      setPhase("failed");
    }
  };

  const put = async (block: string | null) => {
    const line = `${formatTimestamp(at.current)} 💭 ${text.trim()}`;
    const box = block ? `[[${block}]]` : null;
    try {
      await window.__journalFlush?.();
      if (box) await changeDay(store, day.current, (e) => (insertLogLinePM(e, line, box, ACTOR), true), (doc) => withLogLine(doc, line, box), ACTOR);
      else await changeDay(store, day.current, (e) => (e.chain().insertContentAt(e.state.doc.content.size, { type: "paragraph", content: [{ type: "text", text: line }] }).run(), true), (doc) => ({ type: "doc", content: [...(doc?.content ?? []), { type: "paragraph", content: [{ type: "text", text: line }] }] }), ACTOR);
      window.dispatchEvent(new Event("journal:reload-page"));
      showToast(`💭 Saved${block ? ` under [[${block}]]` : " at the end of today"}`);
      onClose();
    } catch (e) {
      showError("Couldn't save the thought", e);
    }
  };

  const cancel = () => (ear.current?.cancel(), onClose());
  useEscapeToClose(cancel);

  return createPortal(
    <div className="thought-wrap" role="dialog" aria-label="Quick thought">
      <div className="thought-card">
        <div className="thought-top">
          <p className={text ? "thought-text" : "thought-text muted"}>{text || (phase === "listening" ? "Say what's on your mind…" : "")}</p>
          <span className="thought-time">{phase === "listening" ? `● ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}` : phase === "writing" ? "● writing" : ""}</span>
        </div>
        <VoicePill level={lvl} mode={phase === "listening" ? "listening" : phase === "writing" ? "thinking" : "idle"} />
        {phase === "listening" && (
          <button type="button" className="thought-key stop" onClick={() => void stop()} aria-label="Stop and write it down">
            ■
          </button>
        )}
        {phase === "writing" && <span className="thought-key" aria-hidden>⋯</span>}
      </div>
      {note && <p className="thought-note">{note}</p>}
      {phase === "pick" && (
        <div className="thought-pick">
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={Math.min(6, Math.ceil(text.length / 40) + 1)} aria-label="The thought" />
          <p className="thought-ask">Which block today?</p>
          <div className="thought-blocks">
            {choices.map((c) => (
              <button key={c.name} type="button" className={c.today ? "today" : ""} onClick={() => void put(c.name)}>
                {c.today ? "📍 " : "＋ "}
                {c.name}
              </button>
            ))}
            <button type="button" onClick={() => void put(null)}>↧ End of today's note</button>
          </div>
        </div>
      )}
      <button type="button" className="thought-cancel" onClick={cancel}>
        {phase === "pick" ? "Discard" : "Cancel"}
      </button>
    </div>,
    document.body,
  );
}
