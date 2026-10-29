import { useEffect, useRef, useState } from "react";
import { appendLogLine, chatMessages, type ChatMessage } from "./lib/chat";
import { dayTitle } from "./lib/timestamp";
import { showError } from "./lib/toast";
import { docText } from "./lib/words";
import type { JournalStore } from "./store";

/** A day as a chat: its log lines as bubbles; each message sent becomes a new log line. */
export function ChatView({ store, day, onClose, onChanged }: { store: JournalStore; day: string; onClose: () => void; onChanged: () => void }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  const load = async () => setMessages(chatMessages((await store.getDay(day))?.content ?? null));
  useEffect(() => {
    void load();
    input.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, day]);
  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight, behavior: "smooth" });
  }, [messages.length]);

  const send = async () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    try {
      const page = await store.getDay(day);
      const content = appendLogLine(page?.content ?? null, text, new Date());
      await store.saveDay({ day, content, plainText: docText(content) });
      await load();
      onChanged();
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
      </header>
      <div ref={list} className="chat-list">
        {!messages.length && <p className="hint chat-empty">Write a message below. Each one is added to this day's note as a timestamped log line.</p>}
        {messages.map((m, i) => (
          <div key={i} className="chat-bubble">
            <span className="chat-text">{m.text}</span>
            <span className="chat-time">{m.time}</span>
          </div>
        ))}
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
