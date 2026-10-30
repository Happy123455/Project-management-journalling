import { Fragment, useEffect, useRef, useState } from "react";
import { appendLogLine, chatMessages, type ChatMessage } from "./lib/chat";
import { dayTitle } from "./lib/timestamp";
import { showError } from "./lib/toast";
import { docText } from "./lib/words";
import type { JournalStore } from "./store";
import { askAi } from "./ai/client";
import { loadAiSettings } from "./ai/settings";
import { cleanAnswer } from "./editor/promptBlock";

/** AI replies stay in the chat on this device (the note keeps only what was written). */
interface Reply {
  /** Shown after this many of the day's messages. */
  after: number;
  text: string;
  by: string;
}
const repliesKey = (day: string) => `dynamic-journal.chat-replies.${day}`;
const AI_KEY = "dynamic-journal.chat-ai";
function readReplies(day: string): Reply[] {
  try {
    return JSON.parse(localStorage.getItem(repliesKey(day)) ?? "[]");
  } catch {
    return [];
  }
}
function saveReplies(day: string, replies: Reply[]) {
  try {
    localStorage.setItem(repliesKey(day), JSON.stringify(replies.slice(-60)));
  } catch {
    // Only a convenience.
  }
}

const SYSTEM =
  "You are a warm, brief companion inside the person's private journal. They write short messages about their day; " +
  "reply like a thoughtful friend in one to three short sentences: reflect what matters, ask at most one gentle question, " +
  "never lecture or list. Use their language. The day's note so far is given for context.";

/** A day as a chat: its log lines as bubbles; each message sent becomes a new log line. */
export function ChatView({ store, day, onClose, onChanged }: { store: JournalStore; day: string; onClose: () => void; onChanged: () => void }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [replies, setReplies] = useState<Reply[]>(() => readReplies(day));
  const [thinking, setThinking] = useState(false);
  const [aiOn, setAiOn] = useState(() => {
    try {
      return localStorage.getItem(AI_KEY) !== "off";
    } catch {
      return true;
    }
  });
  const aiReady = aiOn && loadAiSettings().enabled;
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  const load = async () => setMessages(chatMessages((await store.getDay(day))?.content ?? null));
  useEffect(() => {
    void load();
    input.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, day]);
  useEffect(() => setReplies(readReplies(day)), [day]);
  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight, behavior: "smooth" });
  }, [messages.length, replies.length, thinking]);

  const reply = async (note: string, count: number, latest: string) => {
    setThinking(true);
    try {
      const recent = replies.slice(-6).map((r) => `You replied: ${r.text}`).join("\n");
      const answer = await askAi({
        task: "chat",
        system: SYSTEM,
        text: `Today's note:\n${note.slice(-4000)}\n\n${recent ? recent + "\n\n" : ""}Their new message: ${latest}`,
        maxTokens: 4000,
      });
      const next = [...readReplies(day), { after: count, text: cleanAnswer(answer.text), by: answer.actor }];
      saveReplies(day, next);
      setReplies(next);
    } catch (e) {
      showError("No AI reply", e);
    } finally {
      setThinking(false);
    }
  };

  const send = async () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    try {
      const page = await store.getDay(day);
      const content = appendLogLine(page?.content ?? null, text, new Date());
      await store.saveDay({ day, content, plainText: docText(content) });
      const now = chatMessages(content);
      setMessages(now);
      onChanged();
      if (aiReady) void reply(docText(content), now.length, text);
    } catch (e) {
      setDraft(text);
      showError("Couldn't add the message", e);
    }
  };

  return (
    <div className="chat-view" role="dialog" aria-label="Chat journal">
      <header className="graph-bar">
        <button type="button" onClick={onClose} aria-label="Back to the note">‹</button>
        <h1 className="settings-title">💬 {dayTitle(day)}</h1>
        <button
          type="button"
          className={aiOn ? "chat-ai active" : "chat-ai"}
          onClick={() => {
            const next = !aiOn;
            setAiOn(next);
            try {
              localStorage.setItem(AI_KEY, next ? "on" : "off");
            } catch {
              // Only a convenience.
            }
          }}
          aria-pressed={aiOn}
          title="AI replies"
        >
          🤖 {aiOn ? "On" : "Off"}
        </button>
      </header>
      <div ref={list} className="chat-list">
        {!messages.length && <p className="hint chat-empty">Write a message below. Each one is added to this day's note as a timestamped log line.</p>}
        {replies.filter((r) => r.after === 0).map((r, j) => (
          <div key={`r0-${j}`} className="chat-bubble ai"><span className="chat-text">{r.text}</span><span className="chat-time">{r.by}</span></div>
        ))}
        {messages.map((m, i) => (
          <Fragment key={i}>
            <div className="chat-bubble">
              <span className="chat-text">{m.text}</span>
              <span className="chat-time">{m.time}</span>
            </div>
            {replies.filter((r) => r.after === i + 1).map((r, j) => (
              <div key={j} className="chat-bubble ai">
                <span className="chat-text">{r.text}</span>
                <span className="chat-time">{r.by}</span>
              </div>
            ))}
          </Fragment>
        ))}
        {thinking && <div className="chat-bubble ai thinking"><span className="chat-text">…</span></div>}
      </div>
      <form className="chat-compose" onSubmit={(e) => (e.preventDefault(), void send())}>
        <textarea
          ref={input}
          value={draft}
          rows={1}
          placeholder="Message…"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button type="submit" disabled={!draft.trim()} aria-label="Send">➤</button>
      </form>
    </div>
  );
}
