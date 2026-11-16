// Item 13: the assistant's command bar (✦ on the navigation island: tap to type, hold to talk).
// Anything from "yesterday" or "23 by 67" (answered at once, no AI) to a long list of jobs, run one
// step at a time with each step's progress shown. Edits are the assistant's, with one Undo for the
// whole run. Follow-ups within 10 minutes keep the conversation. A command with a schedule
// ("every day at 9 pm …") becomes a ▶ Do this block in today's note that runs on time.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { JSONContent } from "@tiptap/core";
import type { JournalStore } from "../store";
import { appendBlocks } from "../lib/append";
import { fx } from "../lib/fx";
import { readAloud } from "../lib/readAloud";
import { dayKey } from "../lib/timestamp";
import { docText } from "../lib/words";
import { useEscapeToClose } from "../ui/useEscapeToClose";
import { canListen, startListening, type Listening } from "./listen";
import { ASSISTANT_ACTOR, runAssistant, type Step, type Turn } from "./runner";
import { describeSchedule, splitSchedule, type Schedule } from "./schedule";
import { recordRun, setScheduled, thisDevice } from "./scheduler";

interface ViewTurn {
  q: string;
  steps: Step[];
  answer: string;
  status: "run" | "done" | "fail" | "stopped";
  startedAt: number;
  undo?: number;
  voice?: boolean;
}

// The conversation outlives the bar for 10 minutes (follow-ups keep their context). Each floating
// agent has its own conversation, kept for as long as the agent lives.
type Convo = { turns: ViewTurn[]; at: number };
const convos = new Map<string, Convo>();
const KEEP_MS = 10 * 60_000;
export const forgetConvo = (key: string) => convos.delete(key);

/** What a floating agent's bubble shows while it's folded away. */
export type AgentStatus = "idle" | "run" | "ask" | "done" | "fail";

/** A floating agent (dragged up from Home): the same assistant, in a panel under its bubble. */
export interface AgentChrome {
  key: string;
  actor: string;
  name: string;
  open: boolean;
  onCollapse: () => void;
  onStatus: (s: AgentStatus, last: string) => void;
}

export const ASSIST_EVENT = "journal:assist";
export type AssistRequest = { mode: "type" } | { mode: "talk" } | { mode: "run"; text: string; bid?: string };

const EXAMPLES = [
  ["Go places", "yesterday · 3 nov in a new tab · last monday · open Work log · today's end"],
  ["Quick answers", "23 by 67 · 15% of 240 · 5 km in miles · days until 25 dec · what day is 1 jan"],
  ["Find and copy", "find an unticked task about college and put it under Journal today"],
  ["Tables", "make a table of my top 10 tags this month · top memes since 1 oct"],
  ["Do things", "remind me at 18:30 to call mom · deadline essay on 24 nov · timer 25 min · log gym start · tick buy milk"],
  ["Read and sum up", "open the 3rd day of my college in a new tab, summarise it in one paragraph and read it"],
  ["Long jobs", "Write one job per line (or paste a block): each line runs in turn, however many."],
  ["Schedules", "every day at 9 pm summarise today and read it · weekdays 7:30 open Work log · today at 6 pm …"],
];

/** A ▶ Do this block at the end of today's note, scheduled on this device. */
async function scheduleJob(store: JournalStore, text: string, schedule: Schedule): Promise<string> {
  const bid = `dt${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const day = dayKey(new Date());
  await window.__journalFlush?.();
  const page = await store.getDay(day);
  const node: JSONContent = { type: "doThis", attrs: { bid, text, schedule: JSON.stringify(schedule), device: thisDevice() } };
  const doc = appendBlocks(page?.content ?? null, [node, { type: "paragraph" }]);
  await store.saveDay({ day, content: doc, plainText: docText(doc), actor: ASSISTANT_ACTOR });
  window.dispatchEvent(new Event("journal:reload-page"));
  setScheduled(bid, { note: day, text, schedule });
  return bid;
}

/** "every day at 9 pm …" schedules; a one-off time only when it's clearly a job for later. */
function scheduleIn(text: string) {
  const s = splitSchedule(text);
  if (!s || !s.rest) return null;
  if (s.schedule.repeat !== "once" || /\b(?:schedule|do (?:this|it))\b/i.test(text)) return s;
  return null;
}

export function CommandBar({ store, request, onClose, agent }: { store: JournalStore; request: AssistRequest; onClose: () => void; agent?: AgentChrome }) {
  const key = agent?.key ?? "main";
  let convo = convos.get(key) ?? { turns: [], at: 0 };
  if (!agent && Date.now() - convo.at > KEEP_MS) convo = { turns: [], at: 0 };
  convos.set(key, convo);
  const [turns, setTurns] = useState<ViewTurn[]>(convo.turns);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [listening, setListening] = useState<Listening | null>(null);
  const [heard, setHeard] = useState("");
  const [note, setNote] = useState("");
  const [ask, setAsk] = useState<{ q: string; answer: (yes: boolean) => void } | null>(null);
  const [help, setHelp] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const viaVoice = useRef(false);

  // A run keeps going when the bar closes (only Stop stops it); a question it was waiting on is a no.
  const actor = agent?.actor ?? ASSISTANT_ACTOR;
  const close = () => {
    listening?.cancel();
    fx("close");
    onClose();
  };
  useEscapeToClose(agent ? () => agent.open && agent.onCollapse() : close);
  const askRef = useRef(ask);
  askRef.current = ask;
  useEffect(() => () => askRef.current?.answer(false), []);
  // An agent that's put away (merged into Home or ✕) is done: its job stops and its talk is
  // forgotten. The plain bar's run keeps going after it closes.
  const isAgent = !!agent;
  useEffect(
    () => () => {
      if (!isAgent) return;
      abort.current?.abort();
      forgetConvo(key);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const keep = (next: ViewTurn[]) => {
    const c = { turns: next.slice(-12), at: Date.now() };
    convos.set(key, c);
    setTurns(c.turns);
  };
  const cur = () => convos.get(key) ?? { turns: [], at: 0 };
  // The bubble shows how its agent is doing (working, waiting on a yes/no, finished).
  const onStatus = agent?.onStatus;
  useEffect(() => {
    if (!onStatus) return;
    const last = turns[turns.length - 1];
    onStatus(ask ? "ask" : running || last?.status === "run" ? "run" : !last ? "idle" : last.status === "fail" ? "fail" : "done", last ? (last.answer || last.q).slice(0, 120) : "");
  }, [turns, ask, running, onStatus]);
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [turns, ask]);

  const run = async (text0: string, opts: { voice?: boolean; bid?: string } = {}) => {
    const text = text0.trim();
    if (!text || running) return;
    setInput("");
    setHeard("");
    fx("start");
    const startedAt = Date.now();
    const turn: ViewTurn = { q: text, steps: [], answer: "", status: "run", startedAt, voice: opts.voice };
    keep([...cur().turns, turn]);
    // Turns are matched by when they started (each update makes a new object for React).
    const put = (patch: Partial<ViewTurn>) => {
      Object.assign(turn, patch);
      keep(cur().turns.map((t) => (t.startedAt === startedAt && t.q === text ? { ...turn } : t)));
    };
    const sched = opts.bid ? null : scheduleIn(text);
    if (sched) {
      try {
        await scheduleJob(store, sched.rest, sched.schedule);
        put({ status: "done", answer: `🕘 Scheduled ${describeSchedule(sched.schedule)}: “${sched.rest}”. It's a ▶ Do this block at the end of today's note, run on this device (if the app is closed then, it runs when you next open it). Run it now with ▶ there.` });
        fx("done");
      } catch (e) {
        put({ status: "fail", answer: e instanceof Error ? e.message : String(e) });
      }
      return;
    }
    setRunning(true);
    const ctl = new AbortController();
    abort.current = ctl;
    const history: Turn[] = cur().turns
      .filter((t) => t.startedAt !== startedAt && t.status === "done")
      .slice(-4)
      .flatMap((t) => [
        { role: "user" as const, content: t.q },
        { role: "assistant" as const, content: t.answer },
      ]);
    try {
      const r = await runAssistant({
        store,
        text,
        history,
        signal: ctl.signal,
        actor,
        onUpdate: (steps) => put({ steps }),
        confirm: (q) =>
          new Promise<boolean>((resolve) => {
            fx("warn");
            setAsk({ q, answer: (yes) => (setAsk(null), resolve(yes)) });
          }),
      });
      const changes = (await store.aiChanges(60)).filter((c) => c.event.actor === actor && Date.parse(c.event.createdAt) >= startedAt - 1000);
      const stopped = ctl.signal.aborted;
      put({ steps: r.steps, answer: r.answer, status: stopped ? "stopped" : r.steps.some((s) => s.status === "fail") ? "fail" : "done", undo: changes.length || undefined });
      fx(stopped ? "stop" : "done");
      if (opts.bid) recordRun(opts.bid, { at: startedAt, ok: !r.steps.some((s) => s.status === "fail"), answer: r.answer.slice(0, 400) });
      if (opts.voice && r.answer.length < 600 && !/read_aloud/.test(JSON.stringify(r.steps))) readAloud(r.answer);
    } catch (e) {
      put({ status: "fail", answer: e instanceof Error ? e.message : String(e) });
      fx("warn");
    } finally {
      setRunning(false);
      abort.current = null;
    }
  };

  const undo = async (t: ViewTurn) => {
    const changes = (await store.aiChanges(60)).filter((c) => c.event.actor === actor && Date.parse(c.event.createdAt) >= t.startedAt - 1000);
    let n = 0;
    for (const c of changes) if (await store.undoAiChange(c.event.id)) n++;
    window.dispatchEvent(new Event("journal:reload-page"));
    fx("undone");
    keep(cur().turns.map((x) => (x.startedAt === t.startedAt ? { ...x, undo: undefined, answer: `${x.answer}\n↩ Undone (${n} of ${changes.length} change${changes.length === 1 ? "" : "s"}).` } : x)));
  };

  const listen = async () => {
    if (listening) {
      const l = listening;
      setListening(null);
      const said = (await l.stop()).trim();
      if (said) {
        viaVoice.current = true;
        // Typed words and said words together; the person can still edit before running.
        setInput((cur) => (cur.trim() ? `${cur.trim()} ${said}` : said));
      }
      setHeard("");
      return said;
    }
    setNote("");
    try {
      const l = await startListening(
        (t) => setHeard(t),
        (n) => setNote(n),
      );
      setListening(l);
      listenRef.current = l;
      fx("start");
      if (pendingRelease.current) {
        pendingRelease.current = false;
        void finishTalk(l);
      }
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    }
    return "";
  };

  // Opened by holding ✦: listen now, and run what was said when the finger lifts.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (request.mode === "talk") void listen();
    else if (request.mode === "run") void run(request.text, { bid: request.bid });
    else window.setTimeout(() => inputRef.current?.focus(), 60);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Let go of ✦: what was said runs (a quick let-go may come before the microphone is on).
  const runRef = useRef(run);
  runRef.current = run;
  const pendingRelease = useRef(false);
  const finishTalk = async (l: Listening) => {
    setListening(null);
    const said = (await l.stop()).trim();
    setHeard("");
    if (said) void runRef.current(said, { voice: true });
    else setNote("Didn't catch that. Hold ✦ and talk, or type.");
  };
  const listenRef = useRef(listening);
  listenRef.current = listening;
  useEffect(() => {
    const onRelease = () => {
      const l = listenRef.current;
      if (l) void finishTalk(l);
      else if (request.mode === "talk") pendingRelease.current = true;
    };
    window.addEventListener("journal:assist-release", onRelease);
    return () => window.removeEventListener("journal:assist-release", onRelease);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = () => {
    const v = viaVoice.current;
    viaVoice.current = false;
    void run(input, { voice: v });
  };

  const panel = (
      <div className={agent ? "dls dls-wide cmd agent-panel" : "dls dls-wide cmd"} role="dialog" aria-label={agent ? agent.name : "Assistant"} hidden={agent ? !agent.open : undefined} onClick={(e) => e.stopPropagation()}>
        {!agent && <div className="dls-grip" />}
        <header className="dls-head">
          <h3 className="cmd-title">✦ {agent ? agent.name : "Assistant"}</h3>
          {turns.length > 0 && !running && (
            <button type="button" className="link cmd-new" onClick={() => keep([])}>
              New
            </button>
          )}
          <button type="button" className="cmd-help-btn" aria-expanded={help} onClick={() => setHelp(!help)} aria-label="What can I ask?">
            ?
          </button>
          {agent && (
            <button type="button" className="dls-x" onClick={agent.onCollapse} aria-label="Fold into its bubble">
              ⌃
            </button>
          )}
          <button type="button" className="dls-x" onClick={close} aria-label={agent ? "Close this agent" : "Close"}>
            ✕
          </button>
        </header>
        {help && (
          <dl className="cmd-help">
            {EXAMPLES.map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
            <p className="hint">Every change is the assistant's: Undo is under its answer and in Settings → AI changes. It asks before deleting or changing a second note.</p>
          </dl>
        )}
        <div className="cmd-list" ref={listRef}>
          {!turns.length && !help && <p className="hint cmd-empty">Ask anything about your notes, or give it jobs. Tap ? for ideas.</p>}
          {turns.map((t, i) => (
            <div key={`${t.startedAt}-${i}`} className={`cmd-turn ${t.status}`}>
              <p className="cmd-q">{t.voice ? "🎙 " : ""}{t.q.length > 400 ? `${t.q.slice(0, 400)}…` : t.q}</p>
              {(t.steps.length > 1 || (t.status === "run" && t.steps.some((s) => s.lines.length))) && (
                <ol className="cmd-steps">
                  {t.steps.map((s, k) => (
                    <li key={k} className={`cmd-step ${s.status}`}>
                      <span className="cmd-step-icon" aria-hidden>{{ wait: "○", run: "✱", done: "✓", fail: "⚠", skip: "–" }[s.status]}</span>
                      <span className="cmd-step-text">{s.text}</span>
                      {s.lines.length > 0 && (s.status === "run" || s.status === "fail") && <span className="cmd-tools">{s.lines.slice(-3).join("  ")}</span>}
                      {t.steps.length > 1 && s.answer && s.status !== "run" && <span className="cmd-step-answer">{s.answer.length > 220 ? `${s.answer.slice(0, 220)}…` : s.answer}</span>}
                    </li>
                  ))}
                </ol>
              )}
              {t.status === "run" && t.steps.length <= 1 && <p className="cmd-wait">Working…</p>}
              {t.answer && <p className="cmd-a">{t.answer}</p>}
              {t.status !== "run" && t.answer && (
                <div className="cmd-actions">
                  <button type="button" className="link" onClick={() => readAloud(t.answer)}>🔊 Read</button>
                  <button type="button" className="link" onClick={() => void navigator.clipboard?.writeText(t.answer)}>Copy</button>
                  {t.undo && (
                    <button type="button" className="link" onClick={() => void undo(t)}>
                      ↩ Undo {t.undo} change{t.undo === 1 ? "" : "s"}
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
          {ask && (
            <div className="cmd-ask" role="alertdialog">
              <p>{ask.q}</p>
              <button type="button" onClick={() => ask.answer(false)}>No</button>
              <button type="button" className="primary" onClick={() => ask.answer(true)}>Yes</button>
            </div>
          )}
        </div>
        {(listening || heard || note) && (
          <p className={`cmd-heard${listening ? " live" : ""}`}>
            {listening && <span className="cmd-dot" aria-hidden />}
            {heard || (listening ? "Listening…" : "")}
            {note && <span className="hint"> {note}</span>}
          </p>
        )}
        <div className="cmd-input">
          <textarea
            ref={inputRef}
            value={input}
            rows={Math.min(8, Math.max(1, input.split("\n").length))}
            placeholder={turns.length ? "Follow up…" : "Ask or tell it what to do…"}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && !input.includes("\n")) {
                e.preventDefault();
                submit();
              }
            }}
          />
          {canListen() && (
            <button type="button" className={`cmd-mic${listening ? " on" : ""}`} onClick={() => void listen()} aria-label={listening ? "Stop listening" : "Talk"}>
              🎙
            </button>
          )}
          {running ? (
            <button type="button" className="cmd-go stop" onClick={() => abort.current?.abort()}>
              Stop
            </button>
          ) : (
            <button type="button" className="cmd-go primary" disabled={!input.trim()} onClick={submit}>
              Go
            </button>
          )}
        </div>
      </div>
  );
  // A floating agent's panel is drawn by its bubble; the plain assistant is a sheet over the page.
  if (agent) return panel;
  return createPortal(
    <div className="dls-back cmd-back" onClick={close}>
      {panel}
    </div>,
    document.body,
  );
}
