import { useCallback, useEffect, useMemo, useRef, useState, type TouchEvent } from "react";
import type { Editor, JSONContent } from "@tiptap/react";
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
import { SettingsPanel } from "./settings/SettingsPanel";
import { ReadAloudPlayer } from "./ReadAloudPlayer";
import { repairLostLinks } from "./lib/repairLinks";
import { mcpAvailable, mcpEnabled, setMcpServer } from "./mcp";
import { loadGestures, NO_SWIPE, type CanvasAction } from "./lib/gestures";
import { ChatView } from "./ChatView";
import { NexusView, type NexusTarget } from "./NexusView";
import { openVoiceRecorder, VoiceRecorder } from "./editor/VoiceRecorder";
import { MemeKit } from "./editor/MemeKit";
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
import { dayBlockId } from "./store/ids";
import "./App.css";

const SAVE_DELAY_MS = 800;

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
  const [nexus, setNexus] = useState<NexusTarget | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
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
  // The day `page` and `content` were loaded for: the editor waits until it matches `day`, so it is
  // never created for one day with another day's text.
  const [loadedDay, setLoadedDay] = useState<string | null>(null);
  const swipe = useRef<{ x: number; y: number; onBar: boolean } | null>(null);
  const pending = useRef<{ day: string; content: JSONContent; plainText: string } | null>(null);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    openStore()
      .then((s) => {
        setAttachmentStore(s);
        // Mac: the MCP server for Claude Desktop, if it was left on.
        if (mcpAvailable() && mcpEnabled()) void setMcpServer(s, true).catch((e) => showError("Couldn't start the MCP server", e));
        // Maintenance from the dev tools: restore [[links]] lost to the stale-reopen bug.
        (window as unknown as { __journalRepairLinks?: (dryRun?: boolean) => unknown }).__journalRepairLinks = (dryRun = true) =>
          repairLostLinks(s, undefined, dryRun);
        setStore(s);
      })
      .catch((e) => showError("Could not open the journal", e));
  }, []);

  // MCP writes save what's being typed first (src/mcp.ts).
  useEffect(() => {
    window.__journalFlush = flush;
  });

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
      setLoadedDay(day);
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

  // Scrolling down into the writing area shrinks the month to its week. Not right after the month was
  // opened from the pinned strip: it grows, the browser shifts the page to keep the text in place, and
  // that shift would look like a scroll down and fold it again at once.
  const openedAt = useRef(0);
  useEffect(() => {
    let lastY = window.scrollY;
    const onScroll = () => {
      const y = window.scrollY;
      if (y > lastY + 4 && y > 60 && Date.now() - openedAt.current > 900) setCalendarCollapsed(true);
      lastY = y;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Shared in from other apps (Android share sheet), or a quick note from the shortcut/tile:
  // add it to today's note and show today; for a quick note, open the keyboard at the end.
  const quickNote = useRef<false | "note" | "voice">(false);
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
      quickNote.current = result.voice ? "voice" : result.quickNote ? "note" : false;
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

  // After an AI edit is undone (Settings → AI changes), show the note as it is now.
  useEffect(() => {
    const reload = () => {
      setPageVersion((n) => n + 1);
      setSyncTick((n) => n + 1);
    };
    window.addEventListener("journal:reload-page", reload);
    return () => window.removeEventListener("journal:reload-page", reload);
  }, []);

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
      // Only when the number changes (once per word, not per letter): the calendars repaint on it.
      const words = countWords(plainText);
      setCounts((prev) => (prev[day] === words ? prev : { ...prev, [day]: words }));
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
    onOpenDay: (d, line) => {
      if (!line) return void goTo(d);
      // From a backlink: scroll to the mention and light it up for a moment.
      setFind({ where: d, terms: [line.slice(0, 80)], index: 0, count: 0 });
      void goTo(d, true);
      window.setTimeout(() => setFind((f) => (f?.where === d ? null : f)), 3000);
    },
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
  /** ⑂ Nexus for whatever is open: the day, or the named page. */
  const openNexus = async () => {
    setDrawerOpen(false);
    await flush();
    setNexus(
      route.kind === "page"
        ? { kind: "page", pageId: route.page.id, blockId: route.page.id, title: route.page.title }
        : { kind: "day", day, blockId: dayBlockId(day), title: dayTitle(day) },
    );
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
    const target = e.target as HTMLElement;
    // Not a gesture: a popup or control in use, or text being selected.
    if (target.closest?.(NO_SWIPE) || !(window.getSelection()?.isCollapsed ?? true)) {
      swipe.current = null;
      return;
    }
    swipe.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, onBar: !!target.closest?.(".month-calendar") };
  };
  // A right swipe on the week strip pulls the drawer out under the finger as it goes.
  const onTouchMove = (e: TouchEvent) => {
    const start = swipe.current;
    if (!start?.onBar || drawerOpen || yearOpen) return;
    const dx = e.touches[0].clientX - start.x;
    const dy = e.touches[0].clientY - start.y;
    const drawer = document.querySelector<HTMLElement>(".drawer");
    if (!drawer || dx < 8 || Math.abs(dx) < Math.abs(dy)) return;
    drawer.style.transition = "none";
    drawer.style.transform = `translateX(calc(-100% + ${Math.min(dx, drawer.offsetWidth)}px))`;
  };
  const runCanvas = (action: CanvasAction) => {
    const editor = document.querySelector<HTMLElement & { editor?: Editor }>(".tiptap")?.editor;
    if (action === "prev") void goTo(addDays(day, -1));
    else if (action === "next") void goTo(addDays(day, 1));
    else if (action === "today") void goTo(today);
    else if (action === "top") window.scrollTo({ top: 0, behavior: "smooth" });
    else if (action === "end") window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" });
    else if (action === "search") setSearchOpen(true);
    else if (action === "capture" && editor) {
      editor.commands.focus("end");
      window.JournalShare?.showKeyboard();
    }
  };
  const onTouchEnd = (e: TouchEvent) => {
    const start = swipe.current;
    swipe.current = null;
    const drawer = document.querySelector<HTMLElement>(".drawer");
    if (drawer) {
      drawer.style.transition = "";
      drawer.style.transform = "";
    }
    if (!start || yearOpen) return;
    const dx = e.changedTouches[0].clientX - start.x;
    const dy = e.changedTouches[0].clientY - start.y;
    if (Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    if (drawerOpen) return dx < 0 && setDrawerOpen(false);
    // The week strip: right opens the menu, left the year (fixed). The note: as set in Settings.
    if (start.onBar) return dx > 0 ? setDrawerOpen(true) : route.kind === "day" ? openYear() : undefined;
    if (route.kind === "day") runCanvas(loadGestures()[dx > 0 ? "right" : "left"]);
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
    <div className="app" onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}>
      <aside className="sidebar">
        {store && <ProjectList store={store} refreshKey={`${syncTick}:${days.length}:${route.kind}`} onOpen={(t) => void handlers.onOpenLink(t)} />}
        <h2>Days</h2>
        <DaysList days={days} day={day} today={today} onPick={goTo} />
        <div className="sidebar-actions">
          <button type="button" onClick={() => (setDrawerOpen(false), setGraphOpen(true))}>🕸 Graph view</button>
          <button type="button" onClick={() => void openNexus()}>⑂ Nexus (this note's history)</button>
          <button type="button" onClick={() => (setDrawerOpen(false), setSettingsOpen(true))}>⚙︎ Settings</button>
          <button type="button" onClick={() => (setDrawerOpen(false), void backUpNow())}>💾 Back up now</button>
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
              <button type="button" className="chat-button" onClick={async () => (await flush(), setChatOpen(true))} title="Chat view" aria-label="Chat view">
                💬
              </button>
              <button type="button" className="search-button" onClick={() => setSearchOpen(true)} title="Search (Cmd/Ctrl+K)" aria-label="Search">
                🔍
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
              onToggle={() => {
                if (calendarCollapsed) openedAt.current = Date.now();
                setCalendarCollapsed((c) => !c);
              }}
              onPick={goTo}
              onOpenYear={openYear}
              actions={
                <>
                  <button type="button" onClick={() => setDrawerOpen(true)} aria-label="Open menu">☰</button>
                  <button type="button" onClick={() => setSearchOpen(true)} aria-label="Search">🔍</button>
                  <button type="button" onClick={async () => (await flush(), setChatOpen(true))} aria-label="Chat view">💬</button>
                </>
              }
            />
            {day === today && (
              <DueReminders pages={reminders.filter((r) => r.day <= today)} onPick={goTo} onDone={completeReminder} />
            )}
            {!calendarCollapsed && (
              <Upcoming pages={reminders.filter((r) => r.day > today && r.day !== day).slice(0, 5)} onPick={goTo} />
            )}

            {page === undefined || loadedDay !== day ? (
              <p className="loading">Loading…</p>
            ) : (
              // Only a real tap into the text shrinks the calendar; opening a day (which focuses
              // the editor by itself) keeps the month open.
              <div onPointerDown={() => setCalendarCollapsed(true)}>
                <JournalEditor
                  key={`${day}:${pageVersion}`}
                  // The latest text, not the copy loaded when the day opened: coming back from a
                  // linked page (or search, tags…) remounts the editor and must show what was typed.
                  initialContent={content}
                  onChange={onChange}
                  onReminder={pickReminderDay}
                  onReady={(t) => {
                    setText(t);
                    // A quick note: put the cursor at the end and bring up the keyboard.
                    if (quickNote.current) {
                      const voice = quickNote.current === "voice";
                      quickNote.current = false;
                      setCalendarCollapsed(true);
                      requestAnimationFrame(() => {
                        const editor = document.querySelector<HTMLElement & { editor?: Editor }>(".tiptap")?.editor;
                        if (!editor) return;
                        editor.commands.focus("end");
                        // From the bubble's 🎙: straight into recording.
                        if (voice) openVoiceRecorder(editor, "voice");
                        else window.JournalShare?.showKeyboard();
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
          <button type="button" onClick={() => void openNexus()}>⑂ Nexus (this note's history)</button>
          <button type="button" onClick={() => (setDrawerOpen(false), setSettingsOpen(true))}>⚙︎ Settings</button>
          <button type="button" onClick={() => (setDrawerOpen(false), void backUpNow())}>💾 Back up now</button>
          <SyncStatus status={sync.status} onSync={() => void sync.syncNow()} onChooseFolder={() => void sync.chooseFolder()} />
          <RestoreButton store={store} onBeforeRestore={flush} />
        </div>
      </Drawer>

      {searchOpen && <SearchPanel query={query} onQuery={setQuery} results={results} onPick={openHit} onClose={() => setSearchOpen(false)} />}

      {find && find.where === (route.kind === "page" ? `page:${route.page.title}` : route.kind === "day" ? day : "") && (
        <FindBar index={find.index} count={find.count} onMove={(index) => setFind({ ...find, index })} onClose={() => setFind(null)} />
      )}

      {nexus && store && (
        <NexusView
          store={store}
          target={nexus}
          onClose={() => setNexus(null)}
          onRestored={async () => {
            if (nexus.kind === "page") setRoute({ kind: "page", page: await store.ensurePage(nexus.title) });
            else setPageVersion((n) => n + 1);
            setSyncTick((n) => n + 1);
            setNexus(null);
          }}
        />
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
      {chatOpen && store && (
        <ChatView
          store={store}
          day={day}
          onClose={() => setChatOpen(false)}
          onChanged={() => {
            setPageVersion((n) => n + 1);
            setSyncTick((n) => n + 1);
          }}
        />
      )}
      <VoiceRecorder />
      <ReadAloudPlayer />
      <MemeKit />
      {settingsOpen && <SettingsPanel store={store} onClose={() => setSettingsOpen(false)} />}
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
