import { useEffect, useRef, useState } from "react";
import type { JournalStore } from "./store";
import { askAi, localAvailable } from "./ai/client";
import { coolGenerate, isChatml, type CoolProgress, type LocalMessage } from "./ai/local";
import { agentSystem, parseToolCalls, runTools } from "./ai/agent";
import { loadAiSettings, modelFor, recordUsage, saveAiSettings } from "./ai/settings";
import { actorFor } from "./ai/providers";
import { parseOutline, outlineDoc, type OutlineNode } from "./lib/outline";
import { appendBlocks, textBlocks } from "./lib/append";
import { dayKey } from "./lib/timestamp";
import { docText } from "./lib/words";
import { showError, showToast } from "./lib/toast";

/**
 * Plain AI chat: just the person and the model, no journal context and no system prompt. On the
 * Mac it runs on the local model, made cool (src/ai/local.ts). "Can edit journal" lets the model
 * read and change the journal with tools; at the end a chat can be summed up as a mind map or as
 * how its logic evolved. Chats stay on this device.
 */

interface Msg {
  role: "user" | "assistant";
  content: string;
  thinking?: string;
  /** Tools the model used for this answer. */
  tools?: string[];
  kind?: "map" | "evolution";
  by?: string;
}
interface Chat {
  id: string;
  title: string;
  messages: Msg[];
  updated: number;
}

const CHATS_KEY = "dynamic-journal.ai-chats";
const EDIT_KEY = "dynamic-journal.ai-chat-edit";
const readChats = (): Chat[] => {
  try {
    return JSON.parse(localStorage.getItem(CHATS_KEY) ?? "[]");
  } catch {
    return [];
  }
};
const writeChats = (chats: Chat[]) => {
  try {
    localStorage.setItem(CHATS_KEY, JSON.stringify(chats.slice(0, 40)));
  } catch {
    // Too big: the chat lasts for this session.
  }
};
const newChat = (): Chat => ({ id: crypto.randomUUID(), title: "New chat", messages: [], updated: Date.now() });

const MAP_ASK =
  "Summarise our whole conversation as a mind map. Answer only with a Markdown bullet outline: one root bullet naming the topic, " +
  "then the main branches indented under it, then their details indented further (at most 4 levels, short phrases).";
const EVOLUTION_ASK =
  "Summarise how the logic of our conversation evolved: where we started, each turn the thinking took (what changed it), " +
  "and where we ended up. Use short numbered stages, then one line: Started → Ended.";

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

export function AiChat({ store, onChanged }: { store: JournalStore; onChanged: () => void }) {
  const [chats, setChats] = useState<Chat[]>(readChats);
  const [chat, setChat] = useState<Chat>(() => readChats()[0] ?? newChat());
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<CoolProgress | "waiting" | null>(null);
  const [now, setNow] = useState(Date.now());
  const [edit, setEdit] = useState(() => {
    try {
      return localStorage.getItem(EDIT_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [cool, setCool] = useState(() => loadAiSettings().cool ?? "cool");
  const stop = useRef<AbortController | null>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight, behavior: "smooth" });
  }, [chat.messages.length, busy]);
  // The rest countdown.
  const resting = busy && busy !== "waiting" && busy.restUntil > now;
  useEffect(() => {
    if (!busy || busy === "waiting" || !busy.restUntil) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [busy]);

  const save = (c: Chat) => {
    setChat(c);
    const all = [c, ...readChats().filter((x) => x.id !== c.id)];
    writeChats(all);
    setChats(all);
  };

  /** One answer to these messages; with editing on, the model may call tools first (a few rounds). */
  const answer = async (history: Msg[], ask?: string): Promise<Msg> => {
    const settings = loadAiSettings();
    const model = modelFor({ ...settings, provider: "local" }, "chat");
    const msgs: LocalMessage[] = history.map((m) => ({ role: m.role, content: m.content }));
    if (ask) msgs.push({ role: "user", content: ask });
    const local = settings.enabled && (await localAvailable());
    if (!local || !isChatml(model)) {
      // The phone, or a non-Qwen model: one plain request with the transcript (no tools).
      const text = msgs.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`).join("\n\n") + "\n\nAssistant:";
      const a = await askAi({ task: "chat", system: "", text, maxTokens: 6000 });
      return { role: "assistant", content: a.text.trim(), by: a.actor };
    }
    const actor = actorFor("local", model);
    const tools: string[] = [];
    let thinking = "";
    if (edit && !ask) msgs.unshift({ role: "system", content: agentSystem() });
    for (let round = 0; round < 6; round++) {
      stop.current = new AbortController();
      const out = await coolGenerate({ model, messages: msgs, level: cool, signal: stop.current.signal, onProgress: setBusy });
      recordUsage(model, 0, out.tokens);
      thinking += (thinking && out.thinking ? "\n\n" : "") + out.thinking;
      const { calls, text } = edit && !ask ? parseToolCalls(out.answer) : { calls: [], text: out.answer };
      if (!calls.length) return { role: "assistant", content: text, thinking, tools: tools.length ? tools : undefined, by: actor };
      const r = await runTools(store, calls, actor);
      tools.push(...r.log);
      onChanged();
      msgs.push({ role: "assistant", content: out.answer }, r.message);
    }
    return { role: "assistant", content: "(Stopped after several tool rounds.)", thinking, tools, by: actor };
  };

  const run = async (base: Chat, history: Msg[], ask?: string, kind?: Msg["kind"]) => {
    setBusy("waiting");
    try {
      const reply = await answer(history.filter((m) => !m.kind), ask);
      const c = { ...base, messages: [...history, { ...reply, kind }], updated: Date.now() };
      save(c);
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError")) showError("No AI reply", e);
    } finally {
      setBusy(null);
      stop.current = null;
    }
  };

  const send = () => {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft("");
    const messages: Msg[] = [...chat.messages, { role: "user", content: text }];
    const c = { ...chat, title: chat.messages.length ? chat.title : text.slice(0, 48), messages, updated: Date.now() };
    save(c);
    void run(c, messages);
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

  const setLevel = (level: typeof cool) => {
    setCool(level);
    saveAiSettings({ ...loadAiSettings(), cool: level });
  };
  const status =
    busy === "waiting" ? "Starting…" : busy ? (resting ? `${busy.hot ? "🌡️ Mac warm, cooling" : "❄️ Cooling"} ${Math.ceil((busy.restUntil - now) / 1000)} s` : `${busy.answer ? "Writing" : "Thinking"}… ${busy.speed ? `${busy.speed.toFixed(0)} tok/s` : ""}`) : "";
  const live = busy && busy !== "waiting" ? busy : null;
  const enough = chat.messages.filter((m) => !m.kind).length >= 4;

  return (
    <>
      <div className="ai-chat-bar">
        <select value={chat.id} onChange={(e) => setChat(chats.find((c) => c.id === e.target.value) ?? chat)} aria-label="Chats" disabled={!!busy}>
          {!chats.some((c) => c.id === chat.id) && <option value={chat.id}>{chat.title}</option>}
          {chats.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
        </select>
        <button type="button" onClick={() => setChat(newChat())} disabled={!!busy} title="New chat">＋</button>
        <select value={cool} onChange={(e) => setLevel(e.target.value as typeof cool)} aria-label="Heat" title="Keep the Mac cool: the model works in bursts with rests (same thinking, just slower)">
          <option value="cool">❄️ Cool</option>
          <option value="cold">🧊 Coldest</option>
          <option value="off">🔥 Full speed</option>
        </select>
        <button
          type="button"
          className={edit ? "chat-ai active" : "chat-ai"}
          aria-pressed={edit}
          title="Let the AI read and change the journal (every change can be undone in Settings → AI changes)"
          onClick={() => {
            setEdit(!edit);
            try {
              localStorage.setItem(EDIT_KEY, edit ? "0" : "1");
            } catch {
              // Only a convenience.
            }
          }}
        >
          ✎ {edit ? "Can edit" : "Chat only"}
        </button>
      </div>
      <div ref={list} className="chat-list">
        {!chat.messages.length && (
          <p className="hint chat-empty">
            Just you and the AI: nothing from your journal is sent. Turn on ✎ to let it read and edit your journal when you ask.
          </p>
        )}
        {chat.messages.map((m, i) => (
          <div key={i} className={m.role === "user" ? "chat-bubble" : "chat-bubble ai"}>
            {m.thinking && (
              <details className="ai-thinking">
                <summary>Thought it through</summary>
                <span className="chat-text">{m.thinking}</span>
              </details>
            )}
            {m.tools && <span className="ai-tools">{m.tools.join(" · ")}</span>}
            {m.kind === "map" && parseOutline(m.content).length ? <MapTree nodes={parseOutline(m.content)} /> : <span className="chat-text">{m.content}</span>}
            {m.role === "assistant" && (
              <span className="chat-time">
                {m.by}
                {m.kind && <button type="button" className="ai-save" onClick={() => void toJournal(m)}>＋ Today</button>}
              </span>
            )}
          </div>
        ))}
        {busy && (
          <div className="chat-bubble ai thinking">
            {live?.thinking && !live.answer && <span className="chat-text ai-thinking-live">{live.thinking.slice(-400)}</span>}
            {live?.answer && <span className="chat-text">{live.answer}</span>}
            <span className="chat-time">
              {status}
              <button type="button" className="ai-save" onClick={() => stop.current?.abort()}>Stop</button>
            </span>
          </div>
        )}
      </div>
      {enough && !busy && (
        <div className="ai-summaries">
          <button type="button" onClick={() => void run(chat, chat.messages, MAP_ASK, "map")}>🧠 Mind map summary</button>
          <button type="button" onClick={() => void run(chat, chat.messages, EVOLUTION_ASK, "evolution")}>🧭 How the logic evolved</button>
        </div>
      )}
      <form className="chat-compose" onSubmit={(e) => (e.preventDefault(), send())}>
        <textarea
          value={draft}
          rows={1}
          placeholder="Ask anything…"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button type="submit" disabled={!draft.trim() || !!busy} aria-label="Send">➤</button>
      </form>
    </>
  );
}
