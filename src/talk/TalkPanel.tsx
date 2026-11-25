// 🎙️ Talk (25 Nov: 🎤 interview and 📞 Gujarati call are one button now, English / ગુજરાતી inside).
// Gemini Live first (geminiLive.ts: real voice both ways, never cuts in, Send ends your turn); the
// older turn-by-turn way (Whisper / Gemini Lite + system voice) when Live can't connect.
// The talking journal (talk.ts): a full-screen conversation. It asks (and says it), then
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
import { appendToDay, CALL_ACTOR, CALL_HELLO, callTurn, INTERVIEW_ACTOR, interviewTurn, liveSystem, sessionHead, todayText, translateCall, turnBlocks, type TalkMode, type TalkTurn } from "./talk";
import { openLive, type LiveSession } from "./geminiLive";
import { VoicePill } from "./VoicePill";
import { speakEnglish, speakGujarati, stopSpeaking } from "./speak";

export const OPEN_TALK = "journal:talk";
export const openTalk = (mode: TalkMode = lastMode()) => window.dispatchEvent(new CustomEvent(OPEN_TALK, { detail: mode }));

type Phase = "thinking" | "speaking" | "listening" | "writing" | "failed";

const VOICE_KEY = "journal.talkVoice";
const MODE_KEY = "journal.talkMode";
export const lastMode = (): TalkMode => {
  try {
    return localStorage.getItem(MODE_KEY) === "call" ? "call" : "interview";
  } catch {
    return "interview";
  }
};
const voiceOn = () => {
  try {
    return localStorage.getItem(VOICE_KEY) !== "0";
  } catch {
    return true;
  }
};

export function TalkPanel({ store, mode: mode0, onClose }: { store: JournalStore; mode: TalkMode; onClose: () => void }) {
  const [mode, setMode] = useState<TalkMode>(mode0);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const live = useRef<LiveSession | null>(null);
  const [engine, setEngine] = useState<"live" | "turns" | null>(null);
  const [draft, setDraft] = useState("");
  const lvl = useRef(0);
  const [turns, setTurns] = useState<TalkTurn[]>([]);
  const [phase, setPhase] = useState<Phase>("thinking");
  const [heard, setHeard] = useState("");
  const [note, setNote] = useState("");
  const [secs, setSecs] = useState(0);
  const [voice, setVoice] = useState(voiceOn);
  const phaseRef = useRef<Phase>("thinking");
  phaseRef.current = phase;
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

  const push = (...t: TalkTurn[]) => {
    turnsRef.current = [...turnsRef.current, ...t];
    setTurns(turnsRef.current);
  };
  /** Everything not yet in the note goes in (the heading first). */
  const save = async () => {
    const fresh = turnsRef.current.slice(saved.current);
    if (!fresh.length) return;
    const head = saved.current === 0 ? [sessionHead(modeRef.current, started.current)] : [];
    saved.current = turnsRef.current.length;
    try {
      await appendToDay(store, day.current, [...head, ...turnBlocks(fresh, modeRef.current)], modeRef.current === "call" ? CALL_ACTOR : INTERVIEW_ACTOR);
    } catch (e) {
      saved.current -= fresh.length;
      setNote(`Couldn't save to the note yet: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const showLevel = (l: number) => {
    lvl.current = l;
    level.current?.style.setProperty("--lvl", Math.min(1, l * 4).toFixed(2));
  };

  /** Gemini Live: open it for this mode and let it speak first. False when it can't connect. */
  const startLive = async (): Promise<boolean> => {
    const m = modeRef.current;
    try {
      const today = m === "interview" ? await todayText(store).catch(() => "") : "";
      const s = await openLive(liveSystem(m, today), {
        onHeard: (t) => setHeard(t),
        onSaid: (t) => setDraft(t),
        onLevel: (l) => (lvl.current = l),
        onSpeaking: (on) => {
          if (!alive.current) return;
          if (on) setPhase((phaseRef.current = "speaking"));
          else if (phaseRef.current === "speaking") setPhase((phaseRef.current = "thinking"));
        },
        onTurn: (me, ai) => void liveTurnDone(me, ai),
        onClose: () => {
          if (live.current === s && alive.current) (live.current = null), setEngine("turns"), setNote("Gemini Live ended. Carrying on the usual way."), setPhase("failed");
        },
      }, m === "call" ? "Kore" : "Puck");
      if (!alive.current) return s.close(), true;
      live.current = s;
      setEngine("live");
      setPhase("thinking");
      s.text(m === "call" ? "(The call starts. Greet Hapi in Gujarati and ask how the day was.)" : turnsRef.current.length ? "(Carry on: ask your next question.)" : "(Start: ask your first question about today.)");
      return true;
    } catch (e) {
      console.warn("Gemini Live unavailable, using turns", e);
      return false;
    }
  };

  /** One full exchange came back from Live: into the list and the note, then your turn. */
  const liveTurnDone = async (me: string, ai: string) => {
    setDraft("");
    setHeard("");
    if (modeRef.current === "call") {
      const en = await translateCall(me, ai).catch(() => ({ me: "", ai: "" }));
      if (me) push({ by: "me", text: en.me || me, gu: me });
      if (ai) push({ by: "ai", text: en.ai || ai, gu: ai });
    } else {
      if (me) push({ by: "me", text: me });
      if (ai) push({ by: "ai", text: ai });
    }
    void save();
    // Wait for its voice to finish, then it's your turn.
    const wait = () => (phaseRef.current === "speaking" ? window.setTimeout(wait, 250) : void listen());
    window.setTimeout(wait, 300);
  };

  const listen = async () => {
    if (!alive.current || phaseRef.current === "listening") return;
    setHeard("");
    setSecs(0);
    setPhase("listening");
    haptic("tick", 0.5);
    try {
      const s = live.current;
      if (s) {
        s.begin();
        pcm.current = await recordPcm(showLevel, (chunk) => s.audio(chunk));
      } else if (modeRef.current === "call") pcm.current = await recordPcm(showLevel);
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
    await (modeRef.current === "call" ? speakGujarati(t.gu || t.text) : speakEnglish(words));
  };

  /** The AI's turn: think, show, say, then listen. */
  const aiTurn = async () => {
    setPhase("thinking");
    setNote("");
    try {
      let t: TalkTurn;
      if (modeRef.current === "call") {
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
    if (live.current) {
      const r = pcm.current;
      pcm.current = null;
      await r?.stop();
      live.current.done();
      setPhase("thinking");
      return;
    }
    if (modeRef.current === "call") {
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

  /** English ⇄ ગુજરાતી: the next turns in the other language (what's said so far stays). */
  const switchMode = (m: TalkMode) => {
    if (m === modeRef.current || phase === "writing") return;
    void save();
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      /* this session only */
    }
    stopSpeaking();
    live.current?.close();
    live.current = null;
    pcm.current?.cancel();
    pcm.current = null;
    ear.current?.cancel();
    ear.current = null;
    turnsRef.current = [];
    setTurns([]);
    saved.current = 0;
    lastAudio.current = null;
    started.current = new Date();
    modeRef.current = m;
    setMode(m);
    setPhase((phaseRef.current = "thinking"));
    void startLive().then((ok) => alive.current && !ok && (setEngine("turns"), void aiTurn()));
  };

  const end = () => {
    alive.current = false;
    stopSpeaking();
    live.current?.close();
    live.current = null;
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
    if (!began.current) void startLive().then((ok) => alive.current && !ok && (setEngine("turns"), void aiTurn()));
    began.current = true;
    return () => {
      if (!alive.current) return;
      alive.current = false;
      stopSpeaking();
      live.current?.close();
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
    phase === "thinking" ? (modeRef.current === "call" ? "Thinking…" : "Thinking about what you said…") : phase === "speaking" ? "Speaking… (tap to skip)" : phase === "writing" ? "Writing it down…" : phase === "listening" ? `Listening · ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")} · take your time, then Send` : "";

  return createPortal(
    <div className="talk-sheet" role="dialog" aria-label="Talk">
      <header className="talk-top">
        <b>🎙️ Talk</b>
        <div className="talk-lang" role="radiogroup" aria-label="Language">
          <button type="button" role="radio" aria-checked={mode === "interview"} className={mode === "interview" ? "on" : ""} onClick={() => switchMode("interview")} title="Reflective interview in English">English</button>
          <button type="button" role="radio" aria-checked={modeRef.current === "call"} className={modeRef.current === "call" ? "on" : ""} onClick={() => switchMode("call")} title="A call in Gujarati, saved in English with the Gujarati under it">ગુજરાતી</button>
        </div>
        {engine === "live" && <span className="talk-engine" title="Gemini Live: real voice, it waits for Send">● Live</span>}
        <button type="button" className="talk-voice" aria-pressed={voice} onClick={() => (setVoice(!voice), localStorage.setItem(VOICE_KEY, voice ? "0" : "1"), voice && stopSpeaking())} title="Say the questions out loud">
          {voice ? "🔊" : "🔇"}
        </button>
        <button type="button" className="talk-end" onClick={end}>
          End
        </button>
      </header>
      <div className="talk-list" ref={list} onClick={() => phase === "speaking" && (stopSpeaking(), live.current?.hush())}>
        {turns.map((t, i) => (
          <div key={i} className={`talk-turn ${t.by}`}>
            {t.reflect && <p className="talk-reflect">{t.reflect}</p>}
            <p>{modeRef.current === "call" && t.gu ? t.gu : t.text}</p>
            {modeRef.current === "call" && t.gu && <small>{t.text}</small>}
          </div>
        ))}
        {phase === "listening" && (mode === "interview" || engine === "live") && heard && <div className="talk-turn me live"><p>{heard}</p></div>}
        {draft && <div className="talk-turn ai live"><p>{draft}</p></div>}
      </div>
      <footer className="talk-bottom">
        <VoicePill level={lvl} mode={phase === "listening" ? "listening" : phase === "speaking" ? "speaking" : phase === "thinking" || phase === "writing" ? "thinking" : "idle"} />
        {note && <p className="talk-note">{note}</p>}
        <p className="talk-status">{status}</p>
        {phase === "listening" ? (
          <div className="talk-actions">
            <button type="button" className="talk-redo" hidden={engine === "live"} onClick={redo} title="Throw this recording away and start again">
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
            <button type="button" className="talk-send" onClick={() => void (lastAudio.current || modeRef.current === "interview" ? aiTurn() : listen())}>
              Try again
            </button>
          </div>
        ) : phase === "speaking" ? (
          <div className="talk-actions">
            <button type="button" className="talk-redo" onClick={() => (stopSpeaking(), live.current?.hush())}>
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
