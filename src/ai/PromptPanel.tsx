// ✍️ Prompt studio panel (in AI chat). The flows and the session live in ./promptStudio.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { JournalStore } from "../store";
import type { Provider } from "./providers";
import { copyText } from "../editor/codeBlock";
import { appendBlocks, textBlocks } from "../lib/append";
import { dayKey } from "../lib/timestamp";
import { docText } from "../lib/words";
import { showError, showToast } from "../lib/toast";
import {
  PERSONAS,
  TARGETS,
  compare,
  conversationMd,
  freshSession,
  merge,
  nextQuestion,
  queueQuestion,
  send,
  setStudio,
  start,
  studio,
  subscribeStudio,
  togglePoint,
  tweak,
  undo,
  writeDraft,
  type LogItem,
} from "./promptStudio";
import "./promptStudio.css";

const AIS: { id: Provider; label: string }[] = [
  { id: "gemini", label: "☁️ Gemini" },
  { id: "local", label: "💻 Local (Mac)" },
  { id: "claude", label: "✳️ Claude" },
];
const DEPTHS = [
  { n: 6, label: "Quick · ~6" },
  { n: 12, label: "Standard · ~12" },
  { n: 20, label: "Deep · ~20" },
];

function Dots() {
  return <span className="ps-dots" aria-label="Thinking"><i /><i /><i /></span>;
}

function Bubble({ m, i, live }: { m: LogItem; i: number; live: boolean }) {
  if (m.who === "me") return <div className="chat-bubble ps-me"><span className="chat-text">{m.text}</span></div>;
  if (m.who === "crit")
    return (
      <div className="chat-bubble ai ps-crit">
        <span className="ps-who">🦉 Second opinion{m.kind && m.kind !== "ok" && <em>{m.kind}</em>}</span>
        <span className="chat-text">{m.text}</span>
        {m.askAlso && (
          <span className="ps-also">
            Suggests asking: “{m.askAlso}”{" "}
            {m.queued ? <small>· added</small> : <button type="button" onClick={() => queueQuestion(i)}>＋ Ask this too</button>}
          </span>
        )}
        {m.by && <span className="chat-time">{m.by}</span>}
      </div>
    );
  return (
    <div className="chat-bubble ai ps-ask">
      <span className="ps-who">🎤 Interviewer{m.topic && <em>{m.topic}</em>}</span>
      <span className="chat-text">{m.text}</span>
      {m.why && <span className="ps-why">{m.why}</span>}
      {live && !!m.sugs?.length && (
        <span className="ps-sugs">
          {m.sugs.map((s) => (
            <button key={s} type="button" onClick={() => window.dispatchEvent(new CustomEvent("ps:suggest", { detail: s }))}>{s}</button>
          ))}
        </span>
      )}
      {m.by && <span className="chat-time">{m.by}</span>}
    </div>
  );
}

export function PromptPanel({ store, onChanged, onClose }: { store: JournalStore; onChanged: () => void; onClose: () => void }) {
  const s = useSyncExternalStore(subscribeStudio, studio);
  const [setup, setSetup] = useState(() => ({ brief: s.brief, target: s.target, depth: s.depth, persona: s.persona, live: s.live, asker: s.asker, critic: s.critic }));
  const [draft, setDraft] = useState("");
  const [ask, setAsk] = useState("");
  const list = useRef<HTMLDivElement>(null);
  const busy = (t: string) => s.busy.includes(t);
  const any = s.busy.length > 0;

  useEffect(() => {
    const on = (e: Event) => setDraft((e as CustomEvent<string>).detail);
    window.addEventListener("ps:suggest", on);
    return () => window.removeEventListener("ps:suggest", on);
  }, []);
  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight, behavior: "smooth" });
  }, [s.log.length, s.busy.length, s.phase]);

  const copy = async (text: string, what: string) => {
    try {
      await copyText(text);
      showToast(`${what} copied`);
    } catch (e) {
      showError("Couldn't copy", e);
    }
  };
  const toToday = async () => {
    try {
      await window.__journalFlush?.();
      const day = dayKey(new Date());
      const page = await store.getDay(day);
      const blocks = [
        ...textBlocks(`✍️ Prompt · ${s.brief.split("\n")[0].slice(0, 60)}`),
        { type: "codeBlock", content: [{ type: "text", text: s.final || s.draft }] },
        ...textBlocks(""),
      ];
      const content = appendBlocks(page?.content ?? null, blocks);
      await store.saveDay({ day, content, plainText: docText(content), actor: s.review?.by || "AI" });
      window.dispatchEvent(new Event("journal:reload-page"));
      onChanged();
      showToast("Prompt added to today's note");
    } catch (e) {
      showError("Couldn't add it", e);
    }
  };
  const submit = () => {
    const t = draft.trim();
    if (!t || busy("ask")) return;
    setDraft("");
    void send(t);
  };

  const n = s.qa.length;
  const head = (
    <div className="ai-chat-bar">
      <strong className="ps-title">✍️ Prompt studio</strong>
      {s.phase !== "setup" && <button type="button" className="chat-ai" onClick={() => void copy(conversationMd(s), "Conversation")} title="Copy the whole conversation as Markdown">⧉ Copy all</button>}
      {s.phase !== "setup" && !any && <button type="button" className="chat-ai" onClick={() => setStudio(freshSession(s.critic === "local"))} title="Start over">↺ New</button>}
      <button type="button" onClick={onClose} aria-label="Close" title={any ? "Keeps going; open ✍️ again to see it" : "Close"}>✕</button>
    </div>
  );

  if (s.phase === "setup")
    return (
      <div className="ai-section ps">
        {head}
        <div className="ps-scroll">
          <p className="hint">Describe your project. The Interviewer asks one question at a time, a second AI comments from another viewpoint, and both are merged into one final prompt.</p>
          <textarea className="ps-brief" rows={7} value={setup.brief} placeholder="Paste your raw idea. Messy is fine: the questions fill the gaps." onChange={(e) => setSetup({ ...setup, brief: e.target.value })} />
          <label className="ps-field">Prompt is for
            <select value={setup.target} onChange={(e) => setSetup({ ...setup, target: e.target.value })}>
              {TARGETS.map((t) => <option key={t}>{t}</option>)}
            </select>
          </label>
          <div className="ps-row">
            <label className="ps-field">Length
              <select value={setup.depth} onChange={(e) => setSetup({ ...setup, depth: +e.target.value })}>
                {DEPTHS.map((d) => <option key={d.n} value={d.n}>{d.label}</option>)}
              </select>
            </label>
            <label className="ps-field">🎤 Interviewer
              <select value={setup.asker} onChange={(e) => setSetup({ ...setup, asker: e.target.value as Provider })}>
                {AIS.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
              </select>
            </label>
          </div>
          <div className="ps-row">
            <label className="ps-field">🦉 Second opinion
              <select value={setup.critic} onChange={(e) => setSetup({ ...setup, critic: e.target.value as Provider })}>
                {AIS.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
              </select>
            </label>
            <label className="ps-field">It looks as
              <select value={setup.persona} onChange={(e) => setSetup({ ...setup, persona: e.target.value })}>
                {PERSONAS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
            </label>
          </div>
          <label className="ps-check"><input type="checkbox" checked={setup.live} onChange={(e) => setSetup({ ...setup, live: e.target.checked })} /> Second opinion comments after each answer</label>
          <p className="hint">Local runs on your Mac's model (free, slower). On the phone, or when it isn't running, Gemini answers instead.</p>
          <button type="button" className="ps-primary" disabled={!setup.brief.trim()} onClick={() => void start(setup)}>Start interview</button>
        </div>
      </div>
    );

  const r = s.review;
  return (
    <div className="ai-section ps">
      {head}
      <div className="ps-progress">
        <span>{s.done || s.phase === "synth" ? `${n} answered` : `Question ${n + 1} of ~${s.depth}`}</span>
        <span className="ps-meter"><span style={{ width: `${s.done || s.phase === "synth" ? 100 : Math.min(100, (n / s.depth) * 100)}%` }} /></span>
      </div>
      {(s.covered.length > 0 || s.gaps.length > 0) && s.phase === "interview" && (
        <div className="ps-topics">
          {s.covered.map((t) => <span key={"c" + t} className="on">{t}</span>)}
          {s.gaps.map((t) => <span key={"g" + t}>{t}</span>)}
        </div>
      )}
      <div ref={list} className="chat-list ps-list">
        <div className="chat-bubble ps-me ps-brief-shown"><span className="chat-text">{s.brief}</span></div>
        {s.log.map((m, i) => <Bubble key={i} m={m} i={i} live={i === s.log.length - 1 && !!s.pending} />)}
        {busy("ask") && <div className="chat-bubble ai ps-ask"><span className="ps-who">🎤 Interviewer</span><Dots /></div>}
        {busy("crit") && <div className="chat-bubble ai ps-crit"><span className="ps-who">🦉 Second opinion</span><Dots /></div>}
        {s.error && (
          <div className="chat-bubble ai ps-error">
            ⚠ {s.error}{" "}
            {s.phase === "interview" && !s.pending && !s.done && <button type="button" onClick={() => void nextQuestion()}>Try again</button>}
          </div>
        )}

        {s.phase === "synth" && (
          <div className="ps-synth">
            <div className="ps-h">
              <b>Draft prompt</b>
              {s.draft && <button type="button" onClick={() => void copy(s.draft, "Draft")}>⧉</button>}
              {!any && <button type="button" onClick={() => void writeDraft()}>↻ Rewrite</button>}
            </div>
            {busy("draft") ? <Dots /> : <pre className="ps-prompt">{s.draft}</pre>}

            {(s.draft || r) && (
              <div className="ps-h ps-crit-h">
                <b>🦉 Second opinion{r?.by ? ` · ${r.by}` : ""}</b>
                {!any && s.draft && <button type="button" onClick={() => void compare()}>↻ Compare again</button>}
              </div>
            )}
            {busy("review") && <Dots />}
            {r && (
              <>
                {r.summary && <p className="ps-summary">{r.summary}</p>}
                <div className="ps-scores">
                  {Object.entries(r.scores).map(([k, v]) => <span key={k}>{k} {v}/10</span>)}
                </div>
                {r.agreements.length > 0 && (
                  <details className="ps-fold">
                    <summary>Both agree on {r.agreements.length}</summary>
                    <ul>{r.agreements.map((a) => <li key={a}>{a}</li>)}</ul>
                  </details>
                )}
                <ul className="ps-points">
                  {r.points.map((p, i) => (
                    <li key={i}>
                      <label>
                        <input type="checkbox" checked={p.on} onChange={(e) => togglePoint(i, e.target.checked)} />
                        <span>
                          <b>{p.title}</b> <em className={p.verdict}>{p.verdict === "dont" ? "keep out" : "join"}</em>
                          <small>{p.why}</small>
                          {p.text && <code>{p.text}</code>}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
                {r.comments.length > 0 && (
                  <details className="ps-fold">
                    <summary>Other comments ({r.comments.length})</summary>
                    <ul>{r.comments.map((c) => <li key={c}>{c}</li>)}</ul>
                  </details>
                )}
                <button type="button" className="ps-primary" disabled={any} onClick={() => void merge()}>Build final prompt from ticked points</button>
              </>
            )}

            {(s.final || busy("merge")) && (
              <>
                <div className="ps-h">
                  <b>Final prompt</b>
                  {s.final && <button type="button" onClick={() => void copy(s.final, "Final prompt")}>⧉ Copy</button>}
                  {s.final && <button type="button" onClick={() => void toToday()}>＋ Today</button>}
                </div>
                {busy("merge") ? <Dots /> : <pre className="ps-prompt">{s.final}</pre>}
                {s.final && (
                  <form className="ps-tweak" onSubmit={(e) => (e.preventDefault(), void tweak(ask), setAsk(""))}>
                    <input value={ask} placeholder="Change something… (e.g. shorter, add a test list)" onChange={(e) => setAsk(e.target.value)} />
                    <button type="submit" disabled={!ask.trim() || any}>Apply</button>
                  </form>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {s.phase === "interview" && (
        <>
          <div className="ai-summaries">
            {s.pending && <button type="button" disabled={busy("ask")} onClick={() => void send("(skipped)")}>Skip</button>}
            {s.pending && <button type="button" disabled={busy("ask")} onClick={() => void send("You decide. Pick a sensible default and mark it as an assumption.")}>You decide</button>}
            {n > 0 && <button type="button" disabled={any} onClick={() => { const u = undo(s); setStudio(u.s); setDraft(u.text); }}>↩ Undo</button>}
            {n > 0 && <button type="button" className={s.done ? "ps-go" : ""} disabled={any} onClick={() => void writeDraft()}>{s.done ? "✍️ Write the prompt" : "Finish → prompt"}</button>}
          </div>
          <form className="chat-compose" onSubmit={(e) => (e.preventDefault(), submit())}>
            <textarea
              value={draft}
              rows={2}
              placeholder={s.done ? "Add a note, or write the prompt" : "Your answer…"}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) (e.preventDefault(), submit());
              }}
            />
            <button type="submit" disabled={!draft.trim() || busy("ask")} aria-label="Send">➤</button>
          </form>
        </>
      )}
    </div>
  );
}
