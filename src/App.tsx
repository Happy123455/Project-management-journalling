import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JSONContent } from "@tiptap/react";
import { JournalEditor } from "./editor/JournalEditor";
import { extractLinks } from "./lib/links";
import { addDays, dayKey, dayTitle } from "./lib/timestamp";
import { openStore, type DayPage, type JournalStore } from "./store";
import "./App.css";

const SAVE_DELAY_MS = 800;

function App() {
  const [store, setStore] = useState<JournalStore | null>(null);
  const [day, setDay] = useState(() => dayKey(new Date()));
  const [page, setPage] = useState<DayPage | null | undefined>(undefined);
  const [days, setDays] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [status, setStatus] = useState("");
  const pending = useRef<{ day: string; content: JSONContent; plainText: string } | null>(null);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    openStore().then(setStore).catch((e) => setStatus(`Could not open journal: ${e}`));
  }, []);

  const flush = useCallback(async () => {
    window.clearTimeout(timer.current);
    const next = pending.current;
    if (!store || !next) return;
    pending.current = null;
    try {
      await store.saveDay(next);
      setStatus("Saved");
      setDays(await store.listDays());
    } catch (e) {
      setStatus(`Save failed: ${e}`);
    }
  }, [store]);

  useEffect(() => {
    if (!store) return;
    let cancelled = false;
    setPage(undefined);
    store.getDay(day).then((p) => {
      if (cancelled) return;
      setPage(p);
    });
    store.listDays().then((d) => !cancelled && setDays(d));
    return () => {
      cancelled = true;
    };
  }, [store, day]);

  useEffect(() => {
    const onHide = () => void flush();
    window.addEventListener("beforeunload", onHide);
    return () => window.removeEventListener("beforeunload", onHide);
  }, [flush]);

  const onChange = useCallback(
    (content: JSONContent, plainText: string) => {
      pending.current = { day, content, plainText };
      setText(plainText);
      setStatus("Editing…");
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => void flush(), SAVE_DELAY_MS);
    },
    [day, flush],
  );

  const goTo = async (next: string) => {
    await flush();
    setDay(next);
  };

  const links = useMemo(() => extractLinks(text), [text]);
  const today = dayKey(new Date());

  return (
    <div className="app">
      <aside className="sidebar">
        <h2>Days</h2>
        <ul className="day-list">
          {[...new Set([today, ...days])].map((d) => (
            <li key={d}>
              <button type="button" className={d === day ? "active" : ""} onClick={() => goTo(d)}>
                {d === today ? "Today" : d}
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <main className="page">
        <header className="page-header">
          <button type="button" onClick={() => goTo(addDays(day, -1))} aria-label="Previous day">‹</button>
          <h1>{dayTitle(day)}</h1>
          <button type="button" onClick={() => goTo(addDays(day, 1))} aria-label="Next day">›</button>
          {day !== today && (
            <button type="button" className="today" onClick={() => goTo(today)}>Today</button>
          )}
          <span className="status">{status}</span>
        </header>

        {page === undefined ? (
          <p className="loading">Loading…</p>
        ) : (
          <JournalEditor key={day} initialContent={page?.content ?? null} onChange={onChange} onReady={setText} />
        )}
      </main>

      <aside className="links-panel">
        <h2>On this page</h2>
        <h3>Links</h3>
        {links.wikilinks.length ? (
          <ul>{links.wikilinks.map((l) => <li key={l} className="wikilink">[[{l}]]</li>)}</ul>
        ) : (
          <p className="hint">Type [[ ]] around a name to link it.</p>
        )}
        <h3>Tags</h3>
        {links.tags.length ? (
          <ul>{links.tags.map((t) => <li key={t} className="tag">#{t}</li>)}</ul>
        ) : (
          <p className="hint">Type #idea to tag.</p>
        )}
      </aside>
    </div>
  );
}

export default App;
