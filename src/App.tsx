import { useCallback, useEffect, useMemo, useRef, useState, type TouchEvent } from "react";
import type { JSONContent } from "@tiptap/react";
import { MonthCalendar, YearPanel } from "./calendar/Calendar";
import { DueReminders, Upcoming } from "./calendar/Upcoming";
import { BacklinkList, PageView, TagView, type LinkHandlers } from "./pages/LinkViews";
import { DaysList, Drawer, InfoTabs } from "./panels/Panels";
import { countsByDay, SearchPanel, toResults, type SearchResult } from "./search/SearchPanel";
import { fileKind } from "./lib/files";
import { mediaIdsIn } from "./lib/media";
import { autoBackup, exportBackup } from "./backup";
import { fileUrl, openFile, setAttachmentStore, showPdf, showPhoto } from "./editor/attachments";
import { JournalEditor } from "./editor/JournalEditor";
import { CaptureHost } from "./editor/CaptureHost";
import { PdfHost } from "./editor/PdfHost";
import { PhotoHost } from "./editor/PhotoHost";
import { showError } from "./lib/toast";
import { Toasts } from "./Toasts";
import { extractLinks } from "./lib/links";
import { addDays, dayKey, dayTitle } from "./lib/timestamp";
import { countWords, docText } from "./lib/words";
import { openStore, type DayPage, type JournalStore, type NamedPage, type SearchHit } from "./store";
import "./App.css";

const SAVE_DELAY_MS = 800;
/** How close to the left edge a swipe must start to open the drawer (phone). */
const EDGE_SWIPE_PX = 32;

function App() {
  const [store, setStore] = useState<JournalStore | null>(null);
  const [day, setDay] = useState(() => dayKey(new Date()));
  const [page, setPage] = useState<DayPage | null | undefined>(undefined);
  const [days, setDays] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [status, setStatus] = useState("");
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [calendarCollapsed, setCalendarCollapsed] = useState(false);
  const [yearOpen, setYearOpen] = useState(false);
  const [yearShown, setYearShown] = useState(() => new Date().getFullYear());
  // What the main area shows: today's/any day's page, a named page, or a tag.
  const [route, setRoute] = useState<{ kind: "day" } | { kind: "page"; page: NamedPage } | { kind: "tag"; tag: string }>({ kind: "day" });
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Search: the query stays active (calendars in yellow) after closing the panel, until cleared.
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[] | null>(null);
  // The current day's document, kept up to date while typing (for the Media tab).
  const [content, setContent] = useState<JSONContent | null>(null);
  const swipe = useRef<{ x: number; y: number } | null>(null);
  const pending = useRef<{ day: string; content: JSONContent; plainText: string } | null>(null);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    openStore()
      .then((s) => {
        setAttachmentStore(s);
        setStore(s);
      })
      .catch((e) => showError("Could not open the journal", e));
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
      setStatus("");
      showError("Save failed", e);
    }
  }, [store]);

  useEffect(() => {
    if (!store) return;
    let cancelled = false;
    setPage(undefined);
    store.getDay(day).then((p) => {
      if (cancelled) return;
      setPage(p);
      setContent(p?.content ?? null);
    });
    store.listDays().then((d) => !cancelled && setDays(d));
    return () => {
      cancelled = true;
    };
  }, [store, day]);

  // Daily automatic backup on the Mac: when the journal opens, then hourly while it stays open.
  useEffect(() => {
    if (!store) return;
    const run = () =>
      autoBackup(store)
        .then((made) => made && setStatus("Daily backup saved"))
        .catch((e) => showError("Daily backup failed", e));
    void run();
    const timer = window.setInterval(run, 60 * 60 * 1000);
    return () => window.clearInterval(timer);
  }, [store]);

  const backUpNow = async () => {
    if (!store) return;
    await flush();
    setStatus("Backing up…");
    try {
      const where = await exportBackup(store);
      setStatus(where ? "Backup saved" : "");
    } catch (e) {
      setStatus("");
      showError("Backup failed", e);
    }
  };

  const dayYear = Number(day.slice(0, 4));
  useEffect(() => {
    if (!store) return;
    let cancelled = false;
    for (const y of new Set([dayYear, yearShown])) {
      store.wordCounts(`${y}-01-01`, `${y}-12-31`).then((c) => !cancelled && setCounts((prev) => ({ ...prev, ...c })));
    }
    return () => {
      cancelled = true;
    };
  }, [store, dayYear, yearShown]);

  const today = dayKey(new Date());
  const [reminders, setReminders] = useState<DayPage[]>([]);
  const loadReminders = useCallback(() => {
    store?.openReminders().then(setReminders);
  }, [store]);
  useEffect(loadReminders, [loadReminders, days]);

  const completeReminder = async (d: string) => {
    if (!store) return;
    await store.completeReminder(d);
    loadReminders();
  };

  useEffect(() => {
    const onHide = () => void flush();
    window.addEventListener("beforeunload", onHide);
    return () => window.removeEventListener("beforeunload", onHide);
  }, [flush]);

  const onChange = useCallback(
    (content: JSONContent, plainText: string) => {
      pending.current = { day, content, plainText };
      setContent(content);
      setText(plainText);
      setCounts((prev) => ({ ...prev, [day]: countWords(plainText) }));
      setStatus("Editing…");
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => void flush(), SAVE_DELAY_MS);
    },
    [day, flush],
  );

  const goTo = async (next: string) => {
    await flush();
    setDay(next);
    setRoute({ kind: "day" });
  };

  const handlers: LinkHandlers = {
    onOpenDay: (d) => void goTo(d),
    onOpenLink: async (title) => {
      if (!store || !title.trim()) return;
      await flush();
      setRoute({ kind: "page", page: await store.ensurePage(title) });
    },
    onOpenTag: async (tag) => {
      await flush();
      setRoute({ kind: "tag", tag });
    },
  };
  const pageNames = useCallback(() => store?.pageNames() ?? Promise.resolve([]), [store]);

  const links = useMemo(() => extractLinks(text), [text]);
  // On a person's or topic's page, its own links and tags as they were when it opened.
  const pageLinks = useMemo(
    () => extractLinks(route.kind === "page" ? docText(route.page.content) : ""),
    [route],
  );

  // The "/" Reminder tile: pick a future day (native date picker), then open it to write there.
  const reminderPicker = useRef<HTMLInputElement>(null);
  const pickReminderDay = () => {
    const input = reminderPicker.current;
    if (!input) return;
    input.min = addDays(today, 1);
    input.value = addDays(today, 1);
    try {
      input.showPicker();
    } catch {
      void goTo(addDays(today, 1));
    }
  };

  const openYear = () => {
    setYearShown(dayYear);
    setYearOpen(true);
  };

  // Swiping left anywhere on the page slides the year view in from the right.
  // Phone gestures: swipe right from the left edge opens the drawer; swipe left closes it,
  // or (with the drawer closed) slides the year view in from the right.
  const onTouchStart = (e: TouchEvent) => {
    swipe.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  };
  const onTouchEnd = (e: TouchEvent) => {
    const start = swipe.current;
    swipe.current = null;
    if (!start || yearOpen) return;
    const dx = e.changedTouches[0].clientX - start.x;
    const dy = e.changedTouches[0].clientY - start.y;
    if (Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    if (drawerOpen) return dx < 0 && setDrawerOpen(false);
    if (dx > 0 && start.x < EDGE_SWIPE_PX) return setDrawerOpen(true);
    if (dx < 0 && route.kind === "day") openYear();
  };

  useEffect(() => {
    if (!store || !query.trim()) return setResults(null);
    let live = true;
    store.search(query).then((hits) => live && setResults(toResults(hits, query)));
    return () => {
      live = false;
    };
  }, [store, query, days]);

  const searching = !!query.trim() && !!results;
  const shading = useMemo(
    () => (searching ? { counts: countsByDay(results!), search: true } : { counts, search: false }),
    [searching, results, counts],
  );

  // Cmd/Ctrl+K or Cmd/Ctrl+Shift+F opens search.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && (e.key.toLowerCase() === "k" || (e.shiftKey && e.key.toLowerCase() === "f"))) {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const openHit = async (hit: SearchHit) => {
    setSearchOpen(false);
    if (hit.kind === "day" && hit.day) return goTo(hit.day);
    if (hit.kind === "page" && hit.title) return handlers.onOpenLink(hit.title);
    if (hit.kind === "file") {
      const kind = fileKind(hit.file.mime);
      if (kind === "pdf") return showPdf(hit.file.id);
      if (kind === "image" || kind === "video") return showPhoto(await fileUrl(hit.file.id), kind);
      return openFile(hit.file.id);
    }
  };

  const infoTabs = (
    <InfoTabs
      links={route.kind === "day" ? links : pageLinks}
      mediaIds={route.kind === "day" ? mediaIdsIn(content) : []}
      store={store}
      onOpenLink={(t) => {
        setDrawerOpen(false);
        void handlers.onOpenLink(t);
      }}
      onOpenTag={(t) => {
        setDrawerOpen(false);
        void handlers.onOpenTag(t);
      }}
      backlinks={
        route.kind === "page" && store ? <BacklinkList store={store} title={route.page.title} exclude={route.page.id} handlers={handlers} /> : undefined
      }
    />
  );

  return (
    <div className="app" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
      <aside className="sidebar">
        <h2>Days</h2>
        <DaysList days={days} day={day} today={today} onPick={goTo} />
      </aside>

      <main className="page">
        {route.kind === "page" && store ? (
          <PageView
            key={route.page.id}
            store={store}
            page={route.page}
            onBack={() => setRoute({ kind: "day" })}
            handlers={handlers}
            pageNames={pageNames}
          />
        ) : route.kind === "tag" && store ? (
          <TagView store={store} tag={route.tag} onBack={() => setRoute({ kind: "day" })} handlers={handlers} />
        ) : (
          <>
            <header className="page-header">
              <button type="button" className="menu-button" onClick={() => setDrawerOpen(true)} aria-label="Open menu">☰</button>
              <button type="button" onClick={() => goTo(addDays(day, -1))} aria-label="Previous day">‹</button>
              <h1>{dayTitle(day)}</h1>
              <button type="button" onClick={() => goTo(addDays(day, 1))} aria-label="Next day">›</button>
              {day !== today && (
                <button type="button" className="today" onClick={() => goTo(today)}>Today</button>
              )}
              <span className="status">{status}</span>
              <button type="button" className="search-button" onClick={() => setSearchOpen(true)} title="Search (Cmd/Ctrl+K)" aria-label="Search">
                🔍
              </button>
              <button type="button" className="backup-button" onClick={backUpNow} title="Back up the whole journal" aria-label="Back up journal">
                💾
              </button>
            </header>

            {searching && !searchOpen && (
              <div className="search-active">
                <button type="button" className="search-active-query" onClick={() => setSearchOpen(true)}>
                  🔍 “{query.trim()}” · {results!.length} {results!.length === 1 ? "place" : "places"}
                </button>
                <button type="button" onClick={() => setQuery("")} aria-label="Clear search">✕</button>
              </div>
            )}
            <MonthCalendar
              day={day}
              shading={shading}
              today={today}
              collapsed={calendarCollapsed}
              onToggle={() => setCalendarCollapsed((c) => !c)}
              onPick={goTo}
              onOpenYear={openYear}
            />
            {day === today && (
              <DueReminders pages={reminders.filter((r) => r.day <= today)} onPick={goTo} onDone={completeReminder} />
            )}
            {!calendarCollapsed && (
              <Upcoming pages={reminders.filter((r) => r.day > today && r.day !== day).slice(0, 5)} onPick={goTo} />
            )}

            {page === undefined ? (
              <p className="loading">Loading…</p>
            ) : (
              <div onFocus={() => setCalendarCollapsed(true)}>
                <JournalEditor
                  key={day}
                  initialContent={page?.content ?? null}
                  onChange={onChange}
                  onReady={setText}
                  onReminder={pickReminderDay}
                  onOpenLink={handlers.onOpenLink}
                  onOpenTag={handlers.onOpenTag}
                  pageNames={pageNames}
                />
              </div>
            )}
          </>
        )}
      </main>

      <aside className="links-panel">{infoTabs}</aside>

      <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)}>
        <h2>Days</h2>
        <DaysList
          days={days}
          day={day}
          today={today}
          onPick={(d) => {
            setDrawerOpen(false);
            void goTo(d);
          }}
        />
        {infoTabs}
      </Drawer>

      {searchOpen && <SearchPanel query={query} onQuery={setQuery} results={results} onPick={openHit} onClose={() => setSearchOpen(false)} />}

      <PdfHost />
      <CaptureHost />
      <PhotoHost />
      <Toasts />

      <YearPanel
        year={yearShown}
        day={day}
        shading={shading}
        today={today}
        open={yearOpen}
        onClose={() => setYearOpen(false)}
        onPick={goTo}
        onYear={setYearShown}
      />
    </div>
  );
}

export default App;
