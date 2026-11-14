import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { JournalStore } from "./store";
import { loadAiSettings, saveAiSettings } from "./ai/settings";
import type { CoolLevel } from "./ai/local";
import { LinePicker } from "./ai/LinePicker";
import { DecidePanel } from "./ai/DecidePanel";
import { VoicePanel } from "./ai/VoicePanel";
import { recordingVoice, voiceSession } from "./ai/voiceSession";
import { currentJob, isMac, listChats, loadChat, newChat, saveChat, sendMessage, stopJob, stopWatching, subscribeJob, watchRemote, type Chat, type Msg } from "./ai/chatRunner";
import { parseOutline, outlineDoc, type OutlineNode } from "./lib/outline";
import { appendBlocks, textBlocks } from "./lib/append";
import { dayKey } from "./lib/timestamp";
import { docText } from "./lib/words";
import { showError, showToast } from "./lib/toast";

/**
 * Plain AI chat: just the person and the model, no journal context and no system prompt. Replies
 * run in the background (src/ai/chatRunner.ts) with a 🤖 badge, on the Mac's local model kept
 * cool; the phone hands its messages to the Mac. "✎ Can edit" lets the model change the journal,
 * and "📍 Section" limits it to blocks picked from a note's mini map. Long chats can be summed up as
 * a mind map or as how their logic evolved.
 */

const REMOTE_KEY = "dynamic-journal.ai-chat-remote";
const LAST_KEY = "dynamic-journal.ai-chat-last";
const local = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const setLocal = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    // Only a convenience.
  }
};

function MapTree({ nodes }: { nodes: OutlineNode[] }) {
  return (
    <ul className="ai-map">
      {nodes.map((n, i) => (
        <li key={i}>
          <span>{n.text}</span>
          {n.children.length > 0 && <MapTree nodes={n.children} />}
        </li>
      ))}
    </ul>
  );
}

/** The reasoning in order: numbered thoughts with the tools used between them. */
function Steps({ steps, open }: { steps: { kind: "thought" | "tool"; text: string }[]; open?: boolean }) {
  let n = 0;
  return (
    <details className="ai-thinking" open={open}>
      <summary>🧠 Reasoning · {steps.filter((s) => s.kind === "thought").length} steps</summary>
      <ol className="ai-steps">
        {steps.flatMap((s, i) =>
          s.kind === "tool"
            ? [<li key={i} className="ai-step-tool">{s.text}</li>]
            : s.text.split(/\n\s*\n/).filter((p) => p.trim()).map((p, j) => (
                <li key={`${i}-${j}`} value={++n}>{p.trim()}</li>
              )),
        )}
      </ol>
    </details>
  );
}

export function AiChat({ store, onChanged, openId }: { store: JournalStore; onChanged: () => void; openId?: string | null }) {
  const [chats, setChats] = useState<Chat[]>([]);
  const [chat, setChat] = useState<Chat>(newChat);
  const [draft, setDraft] = useState("");
  const [picking, setPicking] = useState(false);
  const [deciding, setDeciding] = useState(false);
  // 🎙️ Voice graph: open while one records or builds, or when asked for ("voice").
  const [voicing, setVoicing] = useState(() => openId === "voice" || recordingVoice() || voiceSession().phase === "building");
  useEffect(() => {
    if (openId === "voice") setVoicing(true);
  }, [openId]);
  useEffect(() => {
    // The 🎙️ badge while chat is open on another screen.
    const on = (e: Event) => (e as CustomEvent<string>).detail === "voice" && (setDeciding(false), setPicking(false), setVoicing(true));
    window.addEventListener("journal:open-ai-chat", on);
    return () => window.removeEventListener("journal:open-ai-chat", on);
  }, []);
  const [cool, setCool] = useState<CoolLevel>(() => loadAiSettings().cool ?? "cool");
  const [remote, setRemote] = useState(() => !isMac() && local(REMOTE_KEY) !== "0");
  const job = useSyncExternalStore(subscribeJob, currentJob);
  const [now, setNow] = useState(Date.now());
  const list = useRef<HTMLDivElement>(null);
  const mine = job?.chatId === chat.id ? job : null;

  // Chats are journal pages (they sync): reload when a job ends or something arrives.
  const refresh = async (id = chat.id) => {
    const all = await listChats(store);
    setChats(all);
    const c = all.find((x) => x.id === id);
    if (c) setChat(c);
    // The phone after a restart: keep watching for the Mac's answer.
    if (c?.pending && !isMac() && !currentJob()) watchRemote(store, c);
  };
  useEffect(() => {
    void refresh((openId !== "voice" && openId) || local(LAST_KEY) || "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, openId]);
  useEffect(() => {
    if (!job) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.chatId]);
  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight, behavior: "smooth" });
  }, [chat.messages.length, !!mine]);
  useEffect(() => {
    if (!mine?.progress?.restUntil) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [mine?.progress?.restUntil]);

  const update = async (patch: Partial<Chat>) => {
    const c = { ...((await loadChat(store, chat.id)) ?? chat), ...patch };
    setChat(c);
    if (c.messages.length) await saveChat(store, c);
  };
  const open = (c: Chat) => {
    setChat(c);
    setLocal(LAST_KEY, c.id);
  };

  const send = async (kind?: Msg["kind"]) => {
    const text = kind ? null : draft.trim();
    if ((!kind && !text) || mine) return;
    setDraft("");
    try {
      const c = await sendMessage(store, chat, text, kind, remote);
      open(c);
      setChats([c, ...chats.filter((x) => x.id !== c.id)]);
    } catch (e) {
      if (text) setDraft(text);
      showError("Couldn't send", e);
    }
  };

  const toJournal = async (m: Msg) => {
    try {
      await window.__journalFlush?.();
      const day = dayKey(new Date());
      const page = await store.getDay(day);
      const head = textBlocks(m.kind === "map" ? `🧠 Mind map · ${chat.title}` : m.kind === "evolution" ? `🧭 How the logic evolved · ${chat.title}` : `🤖 ${chat.title}`);
      const tree = m.kind === "map" ? parseOutline(m.content) : [];
      const body = tree.length ? [outlineDoc(tree)] : textBlocks(m.content);
      const content = appendBlocks(page?.content ?? null, [...head, ...body]);
      await store.saveDay({ day, content, plainText: docText(content), actor: m.by || "AI" });
      window.dispatchEvent(new Event("journal:reload-page"));
      onChanged();
      showToast("Added to today's note");
    } catch (e) {
      showError("Couldn't add it", e);
    }
  };

  const p = mine?.progress;
  const status = mine?.remote
    ? "💻 Sent to your Mac, it answers when it gets it"
    : !p
      ? job && !mine ? "Waiting for the other reply…" : "Starting…"
      : p.restUntil > now
        ? `${p.hot ? "🌡️ Mac warm, cooling" : "❄️ Cooling"} ${Math.ceil((p.restUntil - now) / 1000)} s`
        : `${p.answer ? "Writing" : "Thinking"}… ${p.speed ? `${p.speed.toFixed(0)} tok/s` : ""}`;
  const enough = chat.messages.filter((m) => !m.kind).length >= 4;
  const waiting = !!chat.pending || !!mine;

  if (picking) return <LinePicker store={store} current={chat.section} onClose={() => setPicking(false)} onPick={(s) => (setPicking(false), void update({ section: s, edit: s ? true : chat.edit }))} />;

  if (deciding) return <DecidePanel store={store} onClose={() => setDeciding(false)} />;
  if (voicing) return <VoicePanel store={store} onChanged={onChanged} onClose={() => setVoicing(false)} />;

  return (
    <>
      <div className="ai-chat-bar">
        <select value={chat.id} onChange={(e) => open(chats.find((c) => c.id === e.target.value) ?? chat)} aria-label="Chats">
          {!chats.some((c) => c.id === chat.id) && <option value={chat.id}>{chat.title}</option>}
          {chats.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
        </select>
        <button type="button" onClick={() => open(newChat())} title="New chat">＋</button>
        <select
          value={cool}
          onChange={(e) => {
            const level = e.target.value as CoolLevel;
            setCool(level);
            saveAiSettings({ ...loadAiSettings(), cool: level });
          }}
          aria-label="Heat"
          title="Keep the Mac cool: the model works in bursts with rests (same thinking, just slower)"
        >
          <option value="cool">❄️ Cool</option>
          <option value="cold">🧊 Coldest</option>
          <option value="off">🔥 Full</option>
        </select>
        {!isMac() && (
          <button type="button" className={remote ? "chat-ai active" : "chat-ai"} onClick={() => (setRemote(!remote), setLocal(REMOTE_KEY, remote ? "0" : "1"))} title="Answer on my Mac (its local model) or here with Gemini">
            {remote ? "💻 Mac" : "☁️ Here"}
          </button>
        )}
      </div>
      <div className="ai-chat-bar ai-chat-scope">
        <button type="button" className={chat.edit ? "chat-ai active" : "chat-ai"} aria-pressed={!!chat.edit} onClick={() => void update({ edit: !chat.edit, section: chat.edit ? null : chat.section })} title="Let the AI read and change the journal (every change can be undone in Settings → AI changes)">
          ✎ {chat.edit ? "Can edit" : "Chat only"}
        </button>
        <button type="button" className={chat.section ? "chat-ai ai-scope-pick active" : "chat-ai ai-scope-pick"} onClick={() => setPicking(true)} title="Limit the AI to one part of a note">
          📍 {chat.section ? chat.section.label : "Section"}
        </button>
        <button type="button" className="chat-ai" onClick={() => setVoicing(true)} title="Voice graph: talk, see the words live, get a structured graph">
          🎙️
        </button>
        <button type="button" className="chat-ai" onClick={() => setDeciding(true)} title="Decision models: cheap yes/no, choice and score judgements (they also place voice graph nodes)">
          ⚖️
        </button>
      </div>
      <div ref={list} className="chat-list">
        {!chat.messages.length && (
          <p className="hint chat-empty">
            Just you and the AI: nothing from your journal is sent. Replies keep going in the background (🤖 at the top). Turn on ✎ to let it edit your journal, or 📍 to limit it to one part of a note.
          </p>
        )}
        {chat.messages.map((m, i) => (
          <div key={i} className={m.role === "user" ? "chat-bubble" : "chat-bubble ai"}>
            {m.steps && <Steps steps={m.steps} />}
            {m.kind === "map" && parseOutline(m.content).length ? <MapTree nodes={parseOutline(m.content)} /> : <span className="chat-text">{m.content}</span>}
            {m.role === "assistant" && (
              <span className="chat-time">
                {m.by}
                {m.kind && <button type="button" className="ai-save" onClick={() => void toJournal(m)}>＋ Today</button>}
              </span>
            )}
          </div>
        ))}
        {waiting && (
          <div className="chat-bubble ai thinking">
            {p?.thinking && <div className="ai-thinking-live">{p.thinking}</div>}
            {p?.answer && <span className="chat-text">{p.answer}</span>}
            <span className="chat-time">
              {status}
              <button type="button" className="ai-save" onClick={() => (mine?.remote || !mine ? stopWatching(store, chat.id) : stopJob())}>Stop</button>
            </span>
          </div>
        )}
      </div>
      {enough && !waiting && (
        <div className="ai-summaries">
          <button type="button" onClick={() => void send("map")}>🧠 Mind map summary</button>
          <button type="button" onClick={() => void send("evolution")}>🧭 How the logic evolved</button>
        </div>
      )}
      <form className="chat-compose" onSubmit={(e) => (e.preventDefault(), void send())}>
        <textarea
          value={draft}
          rows={1}
          placeholder="Ask anything…"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button type="submit" disabled={!draft.trim() || waiting} aria-label="Send">➤</button>
      </form>
    </>
  );
}
