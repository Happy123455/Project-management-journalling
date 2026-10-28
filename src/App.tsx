import { useCallback, useEffect, useMemo, useRef, useState, type TouchEvent } from "react";
import type { JSONContent } from "@tiptap/react";
import { MonthCalendar, YearPanel } from "./calendar/Calendar";
import { DueReminders, Upcoming } from "./calendar/Upcoming";
import { BacklinkList, PageView, TagView, type LinkHandlers } from "./pages/LinkViews";
import { DaysList, Drawer, InfoTabs } from "./panels/Panels";
import { RestoreButton } from "./panels/Restore";
import { SyncStatus } from "./sync/SyncStatus";
import { useSync } from "./sync/useSync";
import { countsByDay, SearchPanel, toResults, type SearchResult } from "./search/SearchPanel";
import { FindBar } from "./search/FindBar";
import { GraphView } from "./graph/GraphView";
import { NewProject } from "./projects/NewProject";
import { ProjectList } from "./projects/ProjectPanel";
import { searchTerms } from "./lib/search";
import { fileKind } from "./lib/files";
import { mediaIdsIn } from "./lib/media";
import { autoBackup, exportBackup } from "./backup";
import { fileUrl, openFile, setAttachmentStore, showPdf, showPhoto } from "./editor/attachments";
import { JournalEditor } from "./editor/JournalEditor";
import { CaptureHost } from "./editor/CaptureHost";
import { PdfHost } from "./editor/PdfHost";
import { PhotoHost } from "./editor/PhotoHost";
import { showError, showToast } from "./lib/toast";
import { takeShare } from "./share";
import { Toasts } from "./Toasts";
import { PullToToday } from "./PullToToday";
import { extractLinks } from "./lib/links";
import { addDays, dayKey, dayTitle } from "./lib/timestamp";
import { countWords, docText } from "./lib/words";
import { openStore, type DayPage, type JournalStore, type NamedPage, type SearchHit } from "./store";
import "./App.css";

const SAVE_DELAY_MS = 800;
/** How close to the left edge a swipe must start to open the drawer (phone). */
const EDGE_SWIPE_PX = 32;
/**
 * Which panel a swipe to the right opens (a swipe to the left opens the other one).
 * "drawer": right → Days/Links/Tags/Media drawer, left → year view. Flip to "year" to swap.
 */
const SWIPE_RIGHT_OPENS: "drawer" | "year" = "drawer";

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
  const [graphOpen, setGraphOpen] = useState(false);
  // Bumped when another device's changes arrive, so lists and calendars reload.
  const [syncTick, setSyncTick] = useState(0);
  // Bumped to reopen the current page in the editor with what arrived (only when not typing).
  const [pageVersion, setPageVersion] = useState(0);
  // Search: the query stays active (calendars in yellow) after closing the panel, until cleared.
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[] | null>(null);
  // Matches highlighted in the note opened from search: on which day/page, and which is current.
  const [find, setFind] = useState<{ where: string; terms: string[]; index: number; count: number } | null>(null);
  // The current day's document, kept up to date while typing (for the Media tab).
  const [content, setContent] = useState<JSONContent | null>(null);
  const swipe = useRef<{ x: number; y: number; onBar: boolean } | null>(null);
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

  const sync = useSync(store, () => {
    setSyncTick((n) => n + 1);
    // Show what arrived on the open page, unless it's being typed in right now.
    const typing = !!pending.current || !!document.activeElement?.closest?.(".tiptap");
    if (!typing) setPageVersion((n) => n + 1);
  });

  const flush = useCallback(async () => {
    window.clearTimeout(timer.current);
    const next = pending.current;
    if (!store || !next) return;
    pending.current = null;
    try {
      await store.saveDay(next);
      setStatus("Saved");
      sync.afterSaved();
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
    return () => {
      cancelled = true;
    };
  }, [store, day, pageVersion]);

  useEffect(() => {
    let cancelled = false;
    store?.listDays().then((d) => !cancelled && setDays(d));
    return () => {
      cancelled = true;
    };
  }, [store, day, syncTick]);

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

  // Scrolling down into the writing area shrinks the month to its week.
  useEffect(() => {
    let lastY = window.scrollY;
    const onScroll = () => {
      const y = window.scrollY;
      if (y > lastY && y > 60) setCalendarCollapsed(true);
      lastY = y;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Shared in from other apps (Android share sheet), or a quick note from the shortcut/tile:
  // add it to today's note and show today; for a quick note, open the keyboard at the end.
  const quickNote = useRef(false);
  useEffect(() => {
    if (!store) return;
    const receive = async () => {
      await flush();
      const result = await takeShare(store, today).catch((e) => {
        showError("Couldn't add what was shared", e);
        return null;
      });
      if (!result) return;
      if (result.added) showToast(result.added === 1 ? "Added to today" : `Added ${result.added} items to today`);
      if (result.skipped.length) showToast(`Too large to add: ${result.skipped.join(", ")}`, "error");
      quickNote.current = result.quickNote;
      setRoute({ kind: "day" });
      setDay(today);
      setPageVersion((n) => n + 1);
      setSyncTick((n) => n + 1);
    };
    void receive();
    window.addEventListener("journal:shared", receive);
    return () => window.removeEventListener("journal:shared", receive);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store]);

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
  }, [store, dayYear, yearShown, syncTick]);

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
    (content: JSONContent, plainText: string, actor?: string) => {
      if (actor && store) {
        // An AI edit is saved at once as its own event (under the AI's name), after anything
        // typed before it, so it can be listed and undone on its own.
        const before = pending.current;
        pending.current = null;
        window.clearTimeout(timer.current);
        void (async () => {
          if (before) await store.saveDay(before);
          await store.saveDay({ day, content, plainText, actor });
          setStatus("Saved");
        })().catch((e) => showError("Save failed", e));
      } else {
        pending.current = { day, content, plainText };
      }
      setContent(content);
      setText(plainText);
      setCounts((prev) => ({ ...prev, [day]: countWords(plainText) }));
      setStatus("Editing…");
      window.clearTimeout(timer.current);
      if (!actor) timer.current = window.setTimeout(() => void flush(), SAVE_DELAY_MS);
    },
    [day, flush, store],
  );

  const goTo = async (next: string, keepFind = false) => {
    await flush();
    setDay(next);
    setRoute({ kind: "day" });
    if (!keepFind) setFind(null);
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
    const onBar = !!(e.target as HTMLElement).closest?.(".month-calendar");
    swipe.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, onBar };
  };
  const onTouchEnd = (e: TouchEvent) => {
    const start = swipe.current;
    swipe.current = null;
    if (!start || yearOpen) return;
    const dx = e.changedTouches[0].clientX - start.x;
    const dy = e.changedTouches[0].clientY - start.y;
    if (Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    if (drawerOpen) return dx < 0 && setDrawerOpen(false);
    // On the calendar bar a swipe works from anywhere; elsewhere the drawer needs an edge swipe.
    const opens = dx > 0 ? SWIPE_RIGHT_OPENS : SWIPE_RIGHT_OPENS === "drawer" ? "year" : "drawer";
    if (opens === "drawer" && (start.onBar || (dx > 0 && start.x < EDGE_SWIPE_PX))) return setDrawerOpen(true);
    if (opens === "year" && route.kind === "day") openYear();
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

  const openHit = async (hit: SearchHit, match: number) => {
    setSearchOpen(false);
    if (hit.kind !== "file") setFind({ where: hit.day ?? `page:${hit.title}`, terms: searchTerms(query), index: match, count: 0 });
    if (hit.kind === "day" && hit.day) return goTo(hit.day, true);
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
        {store && <ProjectList store={store} refreshKey={`${syncTick}:${days.length}:${route.kind}`} onOpen={(t) => void handlers.onOpenLink(t)} />}
        <h2>Days</h2>
        <DaysList days={days} day={day} today={today} onPick={goTo} />
        <div className="sidebar-actions">
          <button type="button" onClick={() => (setDrawerOpen(false), setGraphOpen(true))}>🕸 Graph view</button>
          <SyncStatus status={sync.status} onSync={() => void sync.syncNow()} onChooseFolder={() => void sync.chooseFolder()} />
          <RestoreButton store={store} onBeforeRestore={flush} />
        </div>
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
            find={find?.where === `page:${route.page.title}` ? find : null}
            onPageChanged={(page) => setRoute({ kind: "page", page })}
            onFindCount={(count) => setFind((f) => (f && f.count !== count ? { ...f, count, index: Math.min(f.index, Math.max(0, count - 1)) } : f))}
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
              // Only a real tap into the text shrinks the calendar; opening a day (which focuses
              // the editor by itself) keeps the month open.
              <div onPointerDown={() => setCalendarCollapsed(true)}>
                <JournalEditor
                  key={day}
                  initialContent={page?.content ?? null}
                  onChange={onChange}
                  onReminder={pickReminderDay}
                  onReady={(t) => {
                    setText(t);
                    // A quick note: put the cursor at the end and bring up the keyboard.
                    if (quickNote.current) {
                      quickNote.current = false;
                      setCalendarCollapsed(true);
                      requestAnimationFrame(() => {
                        const editor = document.querySelector<HTMLElement & { editor?: { commands: { focus: (p: string) => void } } }>(".tiptap")?.editor;
                        editor?.commands.focus("end");
                        window.JournalShare?.showKeyboard();
                      });
                    }
                  }}
                  onOpenLink={handlers.onOpenLink}
                  onOpenTag={handlers.onOpenTag}
                  pageNames={pageNames}
                  find={find?.where === day ? find : null}
                  onFindCount={(count) => setFind((f) => (f && f.where === day && f.count !== count ? { ...f, count, index: Math.min(f.index, Math.max(0, count - 1)) } : f))}
                />
              </div>
            )}
          </>
        )}
      </main>

      <aside className="links-panel">{infoTabs}</aside>

      <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)}>
        {store && (
          <ProjectList
            store={store}
            refreshKey={`${syncTick}:${days.length}:${route.kind}`}
            onOpen={(t) => {
              setDrawerOpen(false);
              void handlers.onOpenLink(t);
            }}
          />
        )}
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
        <div className="sidebar-actions">
          <button type="button" onClick={() => (setDrawerOpen(false), setGraphOpen(true))}>🕸 Graph view</button>
          <SyncStatus status={sync.status} onSync={() => void sync.syncNow()} onChooseFolder={() => void sync.chooseFolder()} />
          <RestoreButton store={store} onBeforeRestore={flush} />
        </div>
      </Drawer>

      {searchOpen && <SearchPanel query={query} onQuery={setQuery} results={results} onPick={openHit} onClose={() => setSearchOpen(false)} />}

      {find && find.where === (route.kind === "page" ? `page:${route.page.title}` : route.kind === "day" ? day : "") && (
        <FindBar index={find.index} count={find.count} onMove={(index) => setFind({ ...find, index })} onClose={() => setFind(null)} />
      )}

      {graphOpen && store && (
        <GraphView
          store={store}
          onClose={() => setGraphOpen(false)}
          onOpen={(n) => {
            setGraphOpen(false);
            if (n.kind === "day" && n.day) void goTo(n.day);
            else if (n.kind === "tag") void handlers.onOpenTag(n.label.replace(/^#/, ""));
            else void handlers.onOpenLink(n.label);
          }}
        />
      )}

      <NewProject store={store} />
      <PdfHost />
      <CaptureHost />
      <PhotoHost />
      <Toasts />
      <PullToToday enabled={route.kind === "day" && day !== today && !yearOpen && !drawerOpen} onToday={() => void goTo(today)} />

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
