// 🎤 / 📞 The talking journal (talk.ts): a full-screen conversation. It asks (and says it), then
// records you for as long as you talk; nothing is sent until you press Send. Every answer is in
// today's note the moment it's sent.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { JournalStore } from "../store";
import { startListening, type Listening } from "../assistant/listen";
import { recordPcm, type PcmRecording } from "../ai/voice";
import { haptic } from "../lib/haptic";
import { dayKey } from "../lib/timestamp";
import { useEscapeToClose } from "../ui/useEscapeToClose";
import { appendToDay, CALL_ACTOR, CALL_HELLO, callTurn, INTERVIEW_ACTOR, interviewTurn, sessionHead, todayText, turnBlocks, type TalkMode, type TalkTurn } from "./talk";
import { speakEnglish, speakGujarati, stopSpeaking } from "./speak";

export const OPEN_TALK = "journal:talk";
export const openTalk = (mode: TalkMode) => window.dispatchEvent(new CustomEvent(OPEN_TALK, { detail: mode }));

type Phase = "thinking" | "speaking" | "listening" | "writing" | "failed";

const VOICE_KEY = "journal.talkVoice";
const voiceOn = () => {
  try {
    return localStorage.getItem(VOICE_KEY) !== "0";
  } catch {
    return true;
  }
};

export function TalkPanel({ store, mode, onClose }: { store: JournalStore; mode: TalkMode; onClose: () => void }) {
  const [turns, setTurns] = useState<TalkTurn[]>([]);
  const [phase, setPhase] = useState<Phase>("thinking");
  const [heard, setHeard] = useState("");
  const [note, setNote] = useState("");
  const [secs, setSecs] = useState(0);
  const [voice, setVoice] = useState(voiceOn);
  const level = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const turnsRef = useRef<TalkTurn[]>([]);
  const saved = useRef(0);
  const day = useRef(dayKey(new Date()));
  const started = useRef(new Date());
  const ear = useRef<Listening | null>(null);
  const pcm = useRef<PcmRecording | null>(null);
  const lastAudio = useRef<Float32Array | null>(null);
  const alive = useRef(true);
  const began = useRef(false);
  const voiceRef = useRef(voice);
  voiceRef.current = voice;
  const actor = mode === "call" ? CALL_ACTOR : INTERVIEW_ACTOR;

  const push = (...t: TalkTurn[]) => {
    turnsRef.current = [...turnsRef.current, ...t];
    setTurns(turnsRef.current);
  };
  /** Everything not yet in the note goes in (the heading first). */
  const save = async () => {
    const fresh = turnsRef.current.slice(saved.current);
    if (!fresh.length) return;
    const head = saved.current === 0 ? [sessionHead(mode, started.current)] : [];
    saved.current = turnsRef.current.length;
    try {
      await appendToDay(store, day.current, [...head, ...turnBlocks(fresh, mode)], actor);
    } catch (e) {
      saved.current -= fresh.length;
      setNote(`Couldn't save to the note yet: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const showLevel = (l: number) => level.current?.style.setProperty("--lvl", Math.min(1, l * 4).toFixed(2));

  const listen = async () => {
    if (!alive.current) return;
    setHeard("");
    setSecs(0);
    setPhase("listening");
    haptic("tick", 0.5);
    try {
      if (mode === "call") pcm.current = await recordPcm(showLevel);
      else ear.current = await startListening((t) => setHeard(t), (n) => setNote(n), { lang: "en", onLevel: showLevel });
      if (!alive.current) (pcm.current?.cancel(), ear.current?.cancel());
    } catch (e) {
      setNote(`Can't use the microphone: ${e instanceof Error ? e.message : String(e)}`);
      setPhase("failed");
    }
  };

  const say = async (t: TalkTurn) => {
    if (!voiceRef.current || !alive.current) return;
    setPhase("speaking");
    const words = [t.reflect, t.text].filter(Boolean).join(" ");
    await (mode === "call" ? speakGujarati(t.gu || t.text) : speakEnglish(words));
  };

  /** The AI's turn: think, show, say, then listen. */
  const aiTurn = async () => {
    setPhase("thinking");
    setNote("");
    try {
      let t: TalkTurn;
      if (mode === "call") {
        const audio = lastAudio.current;
        if (!audio) t = CALL_HELLO;
        else {
          const r = await callTurn(turnsRef.current, audio);
          if (!r.heard.text && !r.heard.gu) {
            setNote("Didn't catch any words. Say it again?");
            return void listen();
          }
          push(r.heard);
          lastAudio.current = null;
          void save();
          t = r.reply;
        }
      } else t = await interviewTurn(turnsRef.current, await todayText(store).catch(() => ""));
      if (!alive.current) return;
      push(t);
      await say(t);
      void listen();
    } catch (e) {
      if (!alive.current) return;
      setNote(`No reply yet (${e instanceof Error ? e.message : String(e)}). Your words are saved.`);
      setPhase("failed");
    }
  };

  /** Send: what you said is your answer. */
  const send = async () => {
    if (phase !== "listening") return;
    haptic("press", 0.8);
    setPhase("writing");
    showLevel(0);
    if (mode === "call") {
      const r = pcm.current;
      pcm.current = null;
      const audio = r ? await r.stop() : null;
      if (!audio || audio.length < 16_000 * 0.4) {
        setNote("That was too short. Talk, then Send.");
        return void listen();
      }
      lastAudio.current = audio;
      return void aiTurn();
    }
    const l = ear.current;
    ear.current = null;
    let text = "";
    try {
      text = ((await l?.stop()) ?? "").trim();
    } catch (e) {
      setNote(`Couldn't write it down: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!text) {
      setNote("Didn't catch any words. Say it again?");
      return void listen();
    }
    push({ by: "me", text });
    await save();
    void aiTurn();
  };

  /** Throw away this recording and start it again. */
  const redo = () => {
    ear.current?.cancel();
    ear.current = null;
    pcm.current?.cancel();
    pcm.current = null;
    void listen();
  };

  const end = () => {
    alive.current = false;
    stopSpeaking();
    // Words still being recorded are kept: written down and saved after closing.
    const l = ear.current;
    ear.current = null;
    pcm.current?.cancel();
    void (async () => {
      const text = l ? ((await l.stop().catch(() => "")) ?? "").trim() : "";
      if (text) turnsRef.current = [...turnsRef.current, { by: "me", text }];
      await save();
    })();
    onClose();
  };
  useEscapeToClose(end);

  useEffect(() => {
    alive.current = true;
    // Once (React's dev double-mount would ask twice).
    if (!began.current) void aiTurn();
    began.current = true;
    return () => {
      if (!alive.current) return;
      alive.current = false;
      stopSpeaking();
      ear.current?.cancel();
      pcm.current?.cancel();
      void save();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (phase !== "listening") return;
    const t0 = Date.now();
    const id = window.setInterval(() => setSecs(Math.floor((Date.now() - t0) / 1000)), 1000);
    return () => window.clearInterval(id);
  }, [phase]);
  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight, behavior: "smooth" });
  }, [turns, heard, phase]);

  const status =
    phase === "thinking" ? (mode === "call" ? "Thinking…" : "Thinking about what you said…") : phase === "speaking" ? "Speaking… (tap to skip)" : phase === "writing" ? "Writing it down…" : phase === "listening" ? `Listening · ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")} · take your time, then Send` : "";

  return createPortal(
    <div className="talk-sheet" role="dialog" aria-label={mode === "call" ? "Gujarati call" : "Reflective interview"}>
      <header className="talk-top">
        <b>{mode === "call" ? "📞 Gujarati call" : "🎤 Reflective interview"}</b>
        <button type="button" className="talk-voice" aria-pressed={voice} onClick={() => (setVoice(!voice), localStorage.setItem(VOICE_KEY, voice ? "0" : "1"), voice && stopSpeaking())} title="Say the questions out loud">
          {voice ? "🔊" : "🔇"}
        </button>
        <button type="button" className="talk-end" onClick={end}>
          End
        </button>
      </header>
      <div className="talk-list" ref={list} onClick={() => phase === "speaking" && stopSpeaking()}>
        {turns.map((t, i) => (
          <div key={i} className={`talk-turn ${t.by}`}>
            {t.reflect && <p className="talk-reflect">{t.reflect}</p>}
            <p>{mode === "call" && t.gu ? t.gu : t.text}</p>
            {mode === "call" && t.gu && <small>{t.text}</small>}
          </div>
        ))}
        {phase === "listening" && mode === "interview" && heard && <div className="talk-turn me live"><p>{heard}</p></div>}
      </div>
      <footer className="talk-bottom">
        {note && <p className="talk-note">{note}</p>}
        <p className="talk-status">{status}</p>
        {phase === "listening" ? (
          <div className="talk-actions">
            <button type="button" className="talk-redo" onClick={redo} title="Throw this recording away and start again">
              ↺
            </button>
            <div className="talk-mic" ref={level} aria-hidden>
              🎙️
            </div>
            <button type="button" className="talk-send" onClick={() => void send()}>
              Send ➤
            </button>
          </div>
        ) : phase === "failed" ? (
          <div className="talk-actions">
            <button type="button" className="talk-send" onClick={() => void (lastAudio.current || mode === "interview" ? aiTurn() : listen())}>
              Try again
            </button>
          </div>
        ) : phase === "speaking" ? (
          <div className="talk-actions">
            <button type="button" className="talk-redo" onClick={() => stopSpeaking()}>
              Skip ⏭
            </button>
          </div>
        ) : (
          <div className="talk-actions">
            <div className="talk-dots" aria-hidden>
              <i />
              <i />
              <i />
            </div>
          </div>
        )}
      </footer>
    </div>,
    document.body,
  );
}
