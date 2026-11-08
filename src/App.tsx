import { useCallback, useEffect, useMemo, useRef, useState, type TouchEvent } from "react";
import { closeTopPanel } from "./ui/useEscapeToClose";
import type { Editor, JSONContent } from "@tiptap/react";
import { MonthCalendar, YearPanel } from "./calendar/Calendar";
import { Upcoming, UpcomingPanel, type ReminderAction, type UpcomingPage } from "./calendar/Upcoming";
import { DayPickerSheet } from "./calendar/ReminderSheet";
import { publishReminders, startInAppNudges, upcomingFrom } from "./calendar/reminderBridge";
import { RoutinePanel } from "./routine/RoutinePanel";
import { TodayAgenda } from "./routine/TodayAgenda";
import { editDayLine, ROUTINE_EVENT, useRoutine } from "./routine/routineData";
import { startHealthSync } from "./routine/health";
import { FinancePanel } from "./finance/FinancePanel";
import { startMoneySync } from "./finance/capture";
import { noteLines, reminderLine, timeEdit, timeSpans, type Alarm } from "./lib/reminders";
import { BacklinkList, BacklinksFooter, PageView, TagView, type LinkHandlers } from "./pages/LinkViews";
import { isDayTarget, splitTarget } from "./lib/noteLinks";
import { Drawer, InfoTabs, MEDIA_DRAG, type InsertMedia } from "./panels/Panels";
import { DaysList, MenuSections, MoneyGlance, ProjectList } from "./panels/Menu";
import { RestoreButton } from "./panels/Restore";
import { SyncChip, SyncStatus } from "./sync/SyncStatus";
import { DropPanel } from "./sync/DropPanel";
import type { DropItem } from "./sync/drop";
import { appendBlocks, asBlocks, textBlocks } from "./lib/append";
import { useSync } from "./sync/useSync";
import { countsByDay, SearchPanel, toResults, type SearchResult } from "./search/SearchPanel";
import { FindBar } from "./search/FindBar";
import { GraphView } from "./graph/GraphView";
import { NewProject } from "./projects/NewProject";
import { assignQuickLogIcons, QuickLogSetup } from "./projects/quickLog";
import { SettingsPanel } from "./settings/SettingsPanel";
import { ReadAloudPlayer } from "./ReadAloudPlayer";
import { repairLostLinks } from "./lib/repairLinks";
import { mcpAvailable, mcpEnabled, setMcpServer } from "./mcp";
import { MindMapView } from "./mindmap/MindMapView";
import { isDesktopApp, macBubbleEnabled, setMacBubble } from "./bubble/macBubble";
import { growMap, growPending } from "./mindmap/grow";
import { loadAiSettings } from "./ai/settings";
import { entryFor, numberEntries, type ProjectEntry } from "./lib/projectDays";
import { loadGestures, NO_SWIPE, type CanvasAction } from "./lib/gestures";
import { ChatView } from "./ChatView";
import { RelativeTime } from "./calendar/RelativeTime";
import { NexusView, type NexusTab, type NexusTarget } from "./NexusView";
import { openVoiceRecorder, VoiceRecorder } from "./editor/VoiceRecorder";
import { MemeKit } from "./editor/MemeKit";
import { searchTerms } from "./lib/search";
import { fileKind } from "./lib/files";
import { mediaIdsIn } from "./lib/media";
import { autoBackup, exportBackup } from "./backup";
import { fileUrl, mediaNode, openFile, setAttachmentStore, showPdf, showPhoto } from "./editor/attachments";
import { flushPendingEdits, hasPendingEdits, JournalEditor } from "./editor/JournalEditor";
import { useTouchDevice } from "./editor/KeyboardBar";
import { rememberScroll, recallScroll, restoreScroll, scrollKey } from "./nav/scrollMemory";
import { MacTabBar, NavIsland, TabSwitcher, TitleSearch, type MenuAction } from "./nav/NavIsland";
import { PanelResizer, SidebarEdge, usePanelWidths, useSidebarToggle } from "./nav/PanelResizer";
import { activeTab, closeTab, currentLoc, go, loadTabs, locKey, openTab, saveTabs, switchTab, visit, type Loc, type TabsState } from "./nav/tabs";
import { receiveTyping } from "./sync/liveTyping";
import { editorSaw, guardSave } from "./sync/saveGuard";
import { openTimelines, TimelinesHost } from "./editor/TimelinesView";
import { CaptureHost } from "./editor/CaptureHost";
import { PdfHost } from "./editor/PdfHost";
import { PhotoHost } from "./editor/PhotoHost";
import { showError, showToast } from "./lib/toast";
import { appendQuickNote, takeShare } from "./share";
import { Toasts } from "./Toasts";
import { PullToToday } from "./PullToToday";
import { extractLinks } from "./lib/links";
import { addDays, dayKey, dayTitle } from "./lib/timestamp";
import { countWords, docText } from "./lib/words";
import { openStore, type DayPage, type JournalStore, type NamedPage, type SearchHit } from "./store";
import { dayBlockId } from "./store/ids";
import "./App.css";
import "./themes.css";

const SAVE_DELAY_MS = 800;
/** Numbers the saved copies put into an open note after a sync (see liveTyping). */
let importSeq = 0;

function App() {
  const [store, setStore] = useState<JournalStore | null>(null);
  const [day, setDay] = useState(() => dayKey(new Date()));
  const [page, setPage] = useState<DayPage | null | undefined>(undefined);
  const [days, setDays] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [status, setStatus] = useState("");
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [calendarCollapsed, setCalendarCollapsed] = useState(false);
  // While typing, the week strip folds further to a thin bar; scrolling up a little brings it back.
  const [calendarCompact, setCalendarCompact] = useState(false);
  const [yearOpen, setYearOpen] = useState(false);
  const [upcomingOpen, setUpcomingOpen] = useState(false);
  const [routineOpen, setRoutineOpen] = useState(false);
  const [moneyOpen, setMoneyOpen] = useState(false);
  const [yearShown, setYearShown] = useState(() => new Date().getFullYear());
  // What the main area shows: today's/any day's page, a named page, or a tag.
  const [route, setRoute] = useState<{ kind: "day" } | { kind: "page"; page: NamedPage } | { kind: "tag"; tag: string }>({ kind: "day" });
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [graphOpen, setGraphOpen] = useState(false);
  const [mindOpen, setMindOpen] = useState(false);
  const [nexus, setNexus] = useState<NexusTarget | null>(null);
  const [nexusTab, setNexusTab] = useState<NexusTab>("history");
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
  const swipe = useRef<{ x: number; y: number; t: number; onBar: boolean } | null>(null);
  // Phone: the navigation island's tabs (each with its own back/forward), the title search and the tab list.
  const touch = useTouchDevice();
  const [tabs, setTabs] = useState<TabsState>(() => loadTabs({ kind: "day", day: dayKey(new Date()) }));
  const [titleSearchOpen, setTitleSearchOpen] = useState(false);
  // Opened by holding / swiping up on 🔍 (history first, keyboard down).
  const [titleHistory, setTitleHistory] = useState(false);
  useEffect(() => {
    if (!titleSearchOpen) setTitleHistory(false);
  }, [titleSearchOpen]);
  const [tabsOpen, setTabsOpen] = useState(false);
  usePanelWidths();
  const [sidebarHidden, toggleSidebar] = useSidebarToggle();
  // The next day opens to read, not to type (after a swipe between days).
  const previewNext = useRef(false);
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
        window.setTimeout(() => void assignQuickLogIcons(s).catch(() => {}), 8000);
      })
      .catch((e) => showError("Could not open the journal", e));
  }, []);

  // "Day N" chips on project boxes in the open day (blocks.ts).
  useEffect(() => {
    window.__journalDayNumber = async (title) => {
      if (!store || route.kind !== "day") return null;
      // Projects and every other [[linked]] box count their days the same way.
      const project = await store.getPage(title);
      if (!project) return null;
      const refs = await store.references("wikilink", project.title);
      const entries = numberEntries(refs.flatMap((r) => (r.day ? [entryFor(r.day, r.content as never, project.title)] : [])).filter((e): e is ProjectEntry => !!e));
      return entries.find((e) => e.day === day)?.n ?? null;
    };
  }, [store, route.kind, day]);

  // Mac: notes from the floating bubble window land at the end of today.
  useEffect(() => {
    if (!store || !isDesktopApp()) return;
    if (macBubbleEnabled()) void setMacBubble(true).catch(() => {});
    let off: (() => void) | undefined;
    void import("@tauri-apps/api/event").then(({ listen }) =>
      listen<{ text: string; at: number }>("bubble-note", async (e) => {
        await window.__journalFlush?.();
        await appendQuickNote(store, dayKey(new Date()), e.payload.text, e.payload.at);
        showToast("Added to today");
        window.dispatchEvent(new Event("journal:reload-page"));
      }).then((u) => (off = u)),
    );
    return () => off?.();
  }, [store]);

  // MCP writes save what's being typed first (src/mcp.ts).
  useEffect(() => {
    window.__journalFlush = flush;
  });

  const sync = useSync(store, () => {
    setSyncTick((n) => n + 1);
    window.dispatchEvent(new Event("journal:synced"));
    // Mac: quick logs waiting for an icon get one from the local model.
    if (store) void assignQuickLogIcons(store).catch(() => {});
    // Show what arrived on the open page, unless it's being typed in right now.
    const typing = !!pending.current || !!document.activeElement?.closest?.(".tiptap, .source-text");
    if (!typing) setPageVersion((n) => n + 1);
    else if (store && !pending.current && !hasPendingEdits()) {
      // Typing here, nothing unsaved: put what arrived into the open note in place (cursor kept),
      // and keep the copy the editor reopens with current.
      const open = day;
      void store.getDay(open).then((p) => {
        if (!p || pending.current || hasPendingEdits()) return;
        setContent(p.content);
        editorSaw(`day:${open}`, p.content);
        receiveTyping({ key: `day:${open}`, device: "sync", seq: ++importSeq, full: p.content });
      });
    }
  });

  /** A save from the editor never removes lines the editor didn't show (sync/saveGuard.ts). */
  const guarded = useCallback(async <T extends { day: string; content: JSONContent; plainText: string }>(next: T): Promise<T> => {
    if (!store) return next;
    const stored = (await store.getDay(next.day))?.content;
    const content = guardSave(`day:${next.day}`, next.content, stored);
    if (content === next.content) return next;
    // Show the kept lines in the open note too (merged in, never over what's being typed).
    receiveTyping({ key: `day:${next.day}`, device: "keep", seq: ++importSeq, full: content });
    return { ...next, content, plainText: docText(content) };
  }, [store]);

  const flush = useCallback(async () => {
    // The editor hands over its text once typing pauses; take what was typed just now too.
    flushPendingEdits();
    window.clearTimeout(timer.current);
    const next = pending.current;
    if (!store || !next) return;
    pending.current = null;
    try {
      await store.saveDay(await guarded(next));
      window.dispatchEvent(new Event("journal:saved"));
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
      editorSaw(`day:${day}`, p?.content);
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

  // Mac: the format toolbar sticks right under the calendar, whatever height the calendar has now.
  useEffect(() => {
    const root = document.documentElement;
    let observed: Element | null = null;
    const ro = new ResizeObserver(() => root.style.setProperty("--cal-h", `${observed?.getBoundingClientRect().height ?? 0}px`));
    const find = () => {
      const el = document.querySelector(".page .month-calendar");
      if (el === observed) return;
      if (observed) ro.unobserve(observed);
      observed = el;
      if (el) ro.observe(el);
      else root.style.setProperty("--cal-h", "0px");
    };
    find();
    const mo = new MutationObserver(find);
    mo.observe(document.querySelector(".page") ?? document.body, { childList: true, subtree: false });
    return () => (ro.disconnect(), mo.disconnect());
  }, []);

  // Scrolling down into the writing area shrinks the month to its week. Not right after the month was
  // opened from the pinned strip: it grows, the browser shifts the page to keep the text in place, and
  // that shift would look like a scroll down and fold it again at once.
  const openedAt = useRef(0);
  const settleUntil = useRef(0);
  useEffect(() => {
    let lastY = window.scrollY;
    // Only scrolls the finger (or wheel) made count. The page also moves by itself when the strip
    // changes height or the caret moves; reacting to that folded and unfolded the strip on every
    // letter typed (the flicker) and could loop.
    let userAt = 0;
    const byUser = () => Date.now() - userAt < 600;
    let touchY: number | null = null;
    let touchX: number | null = null;
    let pulled = 0;
    const onScroll = () => {
      const y = window.scrollY;
      // Switching day swaps the note under the finger: the page jumps by itself, which isn't a scroll
      // the hand made (it opened the week strip for a split second, then it snapped back).
      if (byUser() && Date.now() > settleUntil.current) {
        if (y > lastY + 4 && y > 60 && Date.now() - openedAt.current > 900) setCalendarCollapsed(true);
        // Up by a little: the thin bar opens back to the week.
        if (y < lastY) {
          upBy += lastY - y;
          if (upBy > 24) setCalendarCompact(false);
        } else upBy = 0;
      }
      lastY = y;
    };
    let upBy = 0;
    const onTouchStart = (e: globalThis.TouchEvent) => {
      userAt = Date.now();
      touchY = e.touches[0]?.clientY ?? null;
      touchX = e.touches[0]?.clientX ?? null;
      pulled = 0;
    };
    // Dragging the note down (to scroll up) also works at the very top, where nothing scrolls.
    const onTouchMove = (e: globalThis.TouchEvent) => {
      userAt = Date.now();
      const y = e.touches[0]?.clientY;
      if (touchY == null || y == null) return;
      pulled = y - touchY;
      // A pull straight down at the top, not a sideways swipe that drifts a little (day switching).
      const sideways = touchX != null ? Math.abs((e.touches[0]?.clientX ?? touchX) - touchX) : 0;
      if (pulled > 36 && pulled > sideways * 1.5 && window.scrollY < 4 && Date.now() > settleUntil.current) setCalendarCompact(false);
    };
    const onWheel = () => (userAt = Date.now());
    // Typing in the note folds the strip to its thin bar.
    const onInput = (e: Event) => {
      if (!(e.target as HTMLElement).closest?.(".tiptap")) return;
      setCalendarCollapsed(true);
      setCalendarCompact(true);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchmove", onTouchMove, { passive: true });
    window.addEventListener("wheel", onWheel, { passive: true });
    document.addEventListener("beforeinput", onInput, true);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("wheel", onWheel);
      document.removeEventListener("beforeinput", onInput, true);
    };
  }, []);

  // A menu, the year view or a sheet is open: the note behind it can't scroll or be typed into.
  const overlayOpen = drawerOpen || yearOpen || upcomingOpen || settingsOpen || searchOpen || graphOpen || mindOpen || chatOpen || !!nexus || titleSearchOpen || tabsOpen;
  useEffect(() => {
    document.documentElement.classList.toggle("overlay-open", overlayOpen);
    if (overlayOpen) (document.activeElement as HTMLElement | null)?.closest?.(".tiptap") && (document.activeElement as HTMLElement).blur();
  }, [overlayOpen]);
  // The drawer's lists are only drawn while it is open (and while it slides away).
  const [drawerShown, setDrawerShown] = useState(false);
  useEffect(() => {
    if (drawerOpen) return setDrawerShown(true);
    const t = window.setTimeout(() => setDrawerShown(false), 300);
    return () => window.clearTimeout(t);
  }, [drawerOpen]);

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

  // Galaxy Watch (Android): what the watch sent goes into the journal; the watch gets today's state.
  useEffect(() => {
    if (!store || !window.JournalWatch) return;
    let stop = () => {};
    let live = true;
    void import("./watch/watch").then((w) => live && (stop = w.startWatch(store)));
    return () => {
      live = false;
      stop();
    };
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
  // The mind map grows from today's note once it has rested 10 minutes (Settings → AI).
  useEffect(() => {
    const ai = loadAiSettings();
    if (!store || day !== today || !ai.enabled || ai.mindmapAuto === false || countWords(text) <= 50) return;
    // Phone: the Mac (local model) grows the map; it arrives here by sync.
    if (!isDesktopApp() && ai.macGrowsMap !== false) return;
    const t = window.setTimeout(() => void growMap(store, today, 50).catch(() => {}), 10 * 60 * 1000);
    return () => window.clearTimeout(t);
  }, [store, day, today, text]);
  // And it reads the notes it hasn't read yet (or that grew a lot), a few each time the app sits idle.
  useEffect(() => {
    const ai = loadAiSettings();
    if (!store || !ai.enabled || ai.mindmapAuto === false) return;
    if (!isDesktopApp() && ai.macGrowsMap !== false) return;
    const t = window.setTimeout(() => void growPending(store, today, 3).catch(() => {}), 3 * 60 * 1000);
    return () => window.clearTimeout(t);
  }, [store, today]);

  const [reminders, setReminders] = useState<DayPage[]>([]);
  const loadReminders = useCallback(() => {
    store?.openReminders().then(setReminders);
  }, [store]);
  useEffect(loadReminders, [loadReminders, days, syncTick]);
  const upcoming = useMemo(() => upcomingFrom(reminders, today), [reminders, today]);
  // Routine taps and reminder actions: catch up the reminders and the list of days.
  useEffect(() => {
    if (!store) return;
    const on = () => {
      loadReminders();
      void store.listDays().then(setDays);
    };
    window.addEventListener(ROUTINE_EVENT, on);
    return () => window.removeEventListener(ROUTINE_EVENT, on);
  }, [store, loadReminders]);
  useEffect(() => (store ? startHealthSync(store) : undefined), [store]);
  useEffect(() => (store ? startMoneySync(store) : undefined), [store]);
  const { view: routine } = useRoutine(store);
  // Today's own note: its ⏰ lines ring too (a reminder page already rings for every timed line).
  const [todayDoc, setTodayDoc] = useState<JSONContent | null>(null);
  useEffect(() => {
    if (!store) return;
    if (day === today && content) setTodayDoc(content);
    else void store.getDay(today).then((p) => setTodayDoc(p?.content ?? null));
  }, [store, day, today, content, syncTick]);
  // Soft nudges (Routine → Setup): a quiet notification when a step usually starts.
  const nudges = useMemo<Alarm[]>(() => {
    if (!routine?.config.nudges) return [];
    return routine.plan
      .filter((p) => p.start > Date.now() + 5 * 60_000)
      .slice(0, 8)
      .flatMap((p) => {
        const s = routine.config.steps.find((x) => x.id === p.id);
        return s ? [{ id: `routine|${routine.day}|${p.id}`, at: p.start, title: `🧭 ${s.icon} ${s.label}`, body: "Usually about now. At your own pace.", day: today }] : [];
      });
  }, [routine, today]);
  // The phone's notifications and home-screen widget follow the reminders.
  useEffect(() => {
    const own = todayDoc && !reminders.some((r) => r.day === today) ? [{ day: today, content: todayDoc, marked: true }] : [];
    publishReminders(reminders, today, own, nudges);
  }, [reminders, today, todayDoc, nudges]);
  useEffect(() => startInAppNudges((d) => void goTo(d)), []);
  // A tapped notification or widget row opens its day.
  useEffect(() => {
    const open = () => {
      const d = window.JournalReminders?.takeOpenDay?.();
      if (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) void goTo(d);
    };
    open();
    window.addEventListener("journal:open-day", open);
    return () => window.removeEventListener("journal:open-day", open);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store]);

  useEffect(() => {
    const onHide = () => void flush();
    // Phone: switching apps never fires beforeunload; save when the page is hidden.
    const onVisibility = () => document.visibilityState === "hidden" && onHide();
    window.addEventListener("beforeunload", onHide);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("beforeunload", onHide);
      document.removeEventListener("visibilitychange", onVisibility);
    };
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
          if (before) await store.saveDay(await guarded(before));
          await store.saveDay(await guarded({ day, content, plainText, actor }));
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
    settleUntil.current = Date.now() + 900;
    await flush();
    setDay(next);
    setRoute({ kind: "day" });
    if (!keepFind) setFind(null);
  };

  const handlers: LinkHandlers = {
    onOpenDay: (d, line) => {
      if (!line) return void goTo(d);
      // From a backlink: scroll to the mention and light it up for a moment.
      // The link itself, lower-cased like the find matcher: the whole line never matched when it had
      // capitals, a chip or a nested point in it ("No matches here").
      const term = (line.match(/\[\[[^\]]+\]\]|#[\p{L}\p{N}_/-]+/u)?.[0] ?? line.split("\n")[0].slice(0, 80)).toLowerCase();
      setFind({ where: d, terms: [term], index: 0, count: 0 });
      void goTo(d, true);
      window.setTimeout(() => setFind((f) => (f?.where === d ? null : f)), 3000);
    },
    onOpenLink: async (title) => {
      if (!store || !title.trim()) return;
      // [[2026-11-03]] is a day; [[Note#Part]] goes to that part of the note (lit up for a moment).
      const { note, section } = splitTarget(title);
      await flush();
      const light = (where: string) => {
        if (!section) return;
        setFind({ where, terms: [section.toLowerCase()], index: 0, count: 0 });
        window.setTimeout(() => setFind((f) => (f?.where === where ? null : f)), 3000);
      };
      if (isDayTarget(note)) {
        light(note);
        return void goTo(note, !!section);
      }
      const page = await store.ensurePage(note);
      setRoute({ kind: "page", page });
      light(`page:${page.title}`);
    },
    onOpenTag: async (tag) => {
      await flush();
      setRoute({ kind: "tag", tag });
    },
  };
  /** ⑂ Nexus for whatever is open: the day, or the named page. */
  const openNexus = async (tab: NexusTab = "history") => {
    setDrawerOpen(false);
    setNexusTab(tab);
    await flush();
    setNexus(
      route.kind === "page"
        ? { kind: "page", pageId: route.page.id, blockId: route.page.id, title: route.page.title }
        : { kind: "day", day, blockId: dayBlockId(day), title: dayTitle(day) },
    );
  };

  /** Nexus › Send: something that went across, put at the end of today's note. */
  const addDropToToday = async (it: DropItem, data: string | null) => {
    if (!store) return;
    try {
      let blocks;
      if (it.text != null) blocks = textBlocks(it.text);
      else {
        if (!data) return void showToast("That file is no longer kept here", "error");
        const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
        blocks = asBlocks([mediaNode(await store.saveFile({ name: it.name ?? "file", mime: it.mime ?? "application/octet-stream", bytes }))]);
      }
      const today = dayKey(new Date());
      const page = await store.getDay(today);
      const content = appendBlocks(page?.content ?? null, blocks);
      await store.saveDay({ day: today, content, plainText: docText(content) });
      setPageVersion((n) => n + 1);
      showToast("Added to today's note");
    } catch (e) {
      showError("Couldn't add it to today", e);
    }
  };

  const pageNames = useCallback(() => store?.pageNames() ?? Promise.resolve([]), [store]);

  // ───── Tabs and back / forward (the phone's navigation island) ─────
  const loc: Loc = route.kind === "day" ? { kind: "day", day } : route.kind === "page" ? { kind: "page", title: route.page.title } : { kind: "tag", tag: route.tag };
  const here = locKey(loc);
  // Whatever opens on screen becomes the active tab's newest place (going back/forward only moves within it).
  useEffect(() => {
    setTabs((t) => visit(t, loc));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [here]);
  useEffect(() => saveTabs(tabs), [tabs]);
  // The new note settling in (it loads, grows, scroll is restored) isn't the hand scrolling.
  useEffect(() => {
    settleUntil.current = Date.now() + 900;
  }, [here, loadedDay]);
  // Each tab remembers how far down each note was; going back to it scrolls there again.
  const restoring = useRef<number | null>(null);
  const scrollHere = useRef("");
  scrollHere.current = scrollKey(tabs.active, here);
  useEffect(() => {
    let frame = 0;
    const onScroll = () => {
      if (restoring.current != null) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => rememberScroll(scrollHere.current, window.scrollY));
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
    };
  }, []);
  /** Before leaving for another tab / step: where to come back to there. */
  const planRestore = (tabId: string, l: Loc) => {
    rememberScroll(scrollHere.current, window.scrollY);
    const y = recallScroll(scrollKey(tabId, locKey(l)));
    restoring.current = y ?? null;
    if (y != null) previewNext.current = false;
  };
  useEffect(() => {
    const y = restoring.current;
    if (y == null) return;
    restoreScroll(y, () => {
      if (restoring.current === y) restoring.current = null;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [here, tabs.active, loadedDay]);
  const openLoc = (l: Loc) => {
    if (l.kind === "day") return void goTo(l.day);
    if (l.kind === "page") return void handlers.onOpenLink(l.title);
    return void handlers.onOpenTag(l.tag);
  };
  const step = (by: -1 | 1) => {
    const next = go(tabs, by);
    if (!next) return;
    planRestore(next.state.active, next.loc);
    setTabs(next.state);
    openLoc(next.loc);
  };
  const switchToTab = (id: string) => {
    const next = switchTab(tabs, id);
    planRestore(id, currentLoc(activeTab(next)));
    setTabs(next);
    openLoc(currentLoc(activeTab(next)));
  };
  const newTodayTab = () => {
    setTabs((t) => openTab(t, { kind: "day", day: today }));
    void goTo(today);
  };
  /** Double-tap Home: the end of today's note, the cursor there and the keyboard up. */
  const writeAtEnd = () => {
    const focusEnd = () =>
      requestAnimationFrame(() => {
        const editor = document.querySelector<HTMLElement & { editor?: Editor }>(".tiptap")?.editor;
        if (!editor) return;
        setCalendarCollapsed(true);
        editor.commands.focus("end");
        window.JournalShare?.showKeyboard();
        window.scrollTo({ top: document.documentElement.scrollHeight });
      });
    if (route.kind === "day" && day === today) return focusEnd();
    setFind(null);
    quickNote.current = "note";
    void goTo(today);
  };
  const goHome = () => {
    if (route.kind === "day" && day === today) return window.scrollTo({ top: 0, behavior: "smooth" });
    setFind(null);
    void goTo(today);
  };
  // The phone's Back (button or edge swipe): closes what's open on top, then goes back through the
  // tab's notes, then to today. Only when there's nothing left does the app go to the background
  // (MainActivity), instead of closing.
  const backRef = useRef<() => boolean>(() => false);
  backRef.current = () => {
    if (closeTopPanel()) return true;
    const open: [boolean, (v: false) => void][] = [
      [!!dayPicker, () => setDayPicker(null)],
      [tabsOpen, setTabsOpen], [titleSearchOpen, setTitleSearchOpen], [searchOpen, setSearchOpen],
      [settingsOpen, setSettingsOpen], [chatOpen, setChatOpen], [mindOpen, setMindOpen], [graphOpen, setGraphOpen],
      [!!nexus, () => setNexus(null)], [moneyOpen, setMoneyOpen], [routineOpen, setRoutineOpen],
      [upcomingOpen, setUpcomingOpen], [yearOpen, setYearOpen], [drawerOpen, setDrawerOpen],
    ];
    const top = open.find(([on]) => on);
    if (top) return top[1](false), true;
    if (activeTab(tabs).index > 0) return step(-1), true;
    if (route.kind !== "day" || day !== today) return goHome(), true;
    return false;
  };
  useEffect(() => {
    window.journalBack = () => backRef.current();
    return () => {
      window.journalBack = undefined;
    };
  }, []);
  const joyBase = useRef<string | null>(null);
  const joyShown = useRef<string | null>(null);
  const islandActions: MenuAction[] = [
    { icon: "☰", label: "Menu", run: () => setDrawerOpen(true) },
    { icon: "🔎", label: "Search text", run: () => setSearchOpen(true) },
    { icon: "🧭", label: "Routine", run: () => setRoutineOpen(true) },
    { icon: "💬", label: "Chat", run: () => void flush().then(() => setChatOpen(true)) },
    { icon: "📅", label: "Year", run: () => openYear() },
    { icon: "🔔", label: "Coming up", run: () => setUpcomingOpen(true) },
    { icon: "💰", label: "Money", run: () => setMoneyOpen(true) },
    { icon: "🕸", label: "Graph", run: () => setGraphOpen(true) },
    { icon: "🧠", label: "Mind map", run: () => setMindOpen(true) },
    { icon: "⏳", label: "Timelines", run: () => openTimelines() },
    { icon: "⑂", label: "History", run: () => void openNexus() },
    { icon: "⚙︎", label: "Settings", run: () => setSettingsOpen(true) },
  ];
  useEffect(() => {
    document.documentElement.classList.toggle("has-island", touch);
  }, [touch]);

  // The day header's ☰ 🔍 🧭 💬 also ride on the calendar strip once the header has scrolled away;
  // while the header is in sight they'd only show twice, so the strip's copies stay hidden.
  useEffect(() => {
    const root = document.documentElement;
    const header = document.querySelector(".page-header");
    if (!header) return root.classList.remove("header-in-view");
    const io = new IntersectionObserver(([e]) => root.classList.toggle("header-in-view", e.isIntersecting && e.intersectionRatio > 0.5), { threshold: [0, 0.5, 1] });
    io.observe(header);
    return () => io.disconnect();
  }, [route.kind, store]);

  const links = useMemo(() => extractLinks(text), [text]);
  // On a person's or topic's page, its own links and tags as they were when it opened.
  const pageLinks = useMemo(
    () => extractLinks(route.kind === "page" ? docText(route.page.content) : ""),
    [route],
  );

  // The "/" Reminder tile: pick a future day (native date picker), then open it to write there.
  // (It used to open a hidden date field that was never on the page, so the tile did nothing.)
  const [dayPicker, setDayPicker] = useState<{ title: string; from?: string; onPick: (day: string, time?: string) => void; withTime?: boolean } | null>(null);
  /** Text to put at the end of the next day opened, cursor after it (a reminder's "⏰ 15:00 "). */
  const pendingInsert = useRef<string | null>(null);
  const pickReminderDay = () =>
    setDayPicker({
      title: "🔔 Remind me on…",
      withTime: true,
      onPick: (d, time) => {
        setDayPicker(null);
        pendingInsert.current = time ? `⏰ ${time} ` : null;
        void goTo(d);
      },
    });

  /** Moves a reminder's text to another day (added after what that day already has). */
  const moveReminder = async (from: string, to: string) => {
    if (!store || from === to) return;
    await flush();
    const src = await store.getDay(from);
    if (!src || !docText(src.content).trim()) return;
    const dst = await store.getDay(to);
    const kept = (dst?.content.content ?? []).filter((b) => b.content?.length || b.type !== "paragraph");
    const content: JSONContent = { type: "doc", content: [...kept, ...(src.content.content ?? [])] };
    await store.saveDay({ day: to, content, plainText: docText(content) });
    await store.saveDay({ day: from, content: { type: "doc", content: [{ type: "paragraph" }] }, plainText: "" });
    if (src.props.repeat) {
      await store.setDayProps(to, { repeat: src.props.repeat });
      await store.setDayProps(from, { repeat: undefined });
    }
    if (day === from || day === to) setPageVersion((n) => n + 1);
    setDays(await store.listDays());
    loadReminders();
    showToast(`Moved to ${dayTitle(to)}`);
  };
  const onReminderAction = (page: UpcomingPage, a: ReminderAction) => {
    if (!store) return;
    const origin = page.repeatOf ?? page.day;
    if (a.kind === "snooze") void moveReminder(origin, a.to).catch((e) => showError("Couldn't move the reminder", e));
    else if (a.kind === "pick")
      setDayPicker({
        title: "⏰ Move to…",
        from: page.day,
        onPick: (d) => {
          setDayPicker(null);
          void moveReminder(origin, d).catch((e) => showError("Couldn't move the reminder", e));
        },
      });
    else if (a.kind === "time")
      void (async () => {
        await flush();
        const src = await store.getDay(origin);
        const lines = noteLines(src?.content, true);
        const line = lines.find((l) => timeSpans(l).length && reminderLine(l, true)) ?? lines[0];
        if (!line) return;
        const ok = await editDayLine(store, origin, line, timeEdit(line, a.hour, a.minute));
        if (ok && day === origin) setPageVersion((n) => n + 1);
        loadReminders();
        if (ok) showToast(`⏰ ${String(a.hour).padStart(2, "0")}:${String(a.minute).padStart(2, "0")} on ${dayTitle(origin)}`);
      })().catch((e) => showError("Couldn't set the time", e));
    else
      void store
        .setDayProps(origin, { repeat: a.repeat ?? undefined })
        .then(() => {
          loadReminders();
          showToast(a.repeat ? "🔁 It will come back" : "Repeat off");
        })
        .catch((e) => showError("Couldn't save the repeat", e));
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
    // The open drawer can be pushed back with a swipe (not from a control or field in it).
    const inDrawer = drawerOpen && !!target.closest?.(".drawer") && !target.closest?.("input, textarea, video, .media-grid");
    if ((!inDrawer && target.closest?.(NO_SWIPE)) || !(window.getSelection()?.isCollapsed ?? true)) {
      swipe.current = null;
      return;
    }
    swipe.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: e.timeStamp, onBar: !!target.closest?.(".month-calendar") };
  };
  // Panels follow the finger: a right swipe on the week strip (or from the left edge) pulls the
  // drawer out, a left swipe on the strip pulls the year view in, and a left swipe on the open
  // drawer pushes it back. Moved once per frame, on the GPU (transform only).
  const frame = useRef(0);
  const panelUnderFinger = (dx: number, start: { x: number; onBar: boolean }) => {
    if (drawerOpen) return dx < 0 ? { el: document.querySelector<HTMLElement>(".drawer"), at: (w: number) => `translate3d(${Math.max(dx, -w)}px,0,0)` } : null;
    if (yearOpen) return null;
    if (dx > 0 && (start.onBar || start.x < 28)) return { el: document.querySelector<HTMLElement>(".drawer"), at: (w: number) => `translate3d(calc(-100% + ${Math.min(dx, w)}px),0,0)` };
    if (dx < 0 && start.onBar && route.kind === "day") return { el: document.querySelector<HTMLElement>(".year-panel"), at: (w: number) => `translate3d(calc(100% - ${Math.min(-dx, w)}px),0,0)` };
    return null;
  };
  const onTouchMove = (e: TouchEvent) => {
    const start = swipe.current;
    if (!start) return;
    const dx = e.touches[0].clientX - start.x;
    const dy = e.touches[0].clientY - start.y;
    if (Math.abs(dx) < 10 || Math.abs(dx) < Math.abs(dy) * 1.2) return;
    const panel = panelUnderFinger(dx, start);
    if (!panel?.el) return;
    const el = panel.el;
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      el.style.transition = "none";
      el.style.transform = panel.at(el.offsetWidth);
    });
  };
  const runCanvas = (action: CanvasAction) => {
    const editor = document.querySelector<HTMLElement & { editor?: Editor }>(".tiptap")?.editor;
    // Another day by swipe: it opens to read (keyboard down, at its end); tap the text to write there.
    const preview = (next: string) => {
      (document.activeElement as HTMLElement | null)?.blur?.();
      window.JournalShare?.hideKeyboard?.();
      previewNext.current = true;
      void goTo(next);
    };
    if (action === "prev") preview(addDays(day, -1));
    else if (action === "next") preview(addDays(day, 1));
    else if (action === "today") preview(today);
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
    cancelAnimationFrame(frame.current);
    for (const el of document.querySelectorAll<HTMLElement>(".drawer, .year-panel")) {
      el.style.transition = "";
      el.style.transform = "";
    }
    if (!start || yearOpen) return;
    const dx = e.changedTouches[0].clientX - start.x;
    const dy = e.changedTouches[0].clientY - start.y;
    // A quick flick counts as much as a long drag.
    const fast = Math.abs(dx) / Math.max(1, e.timeStamp - start.t) > 0.5;
    if ((Math.abs(dx) < 70 && !(fast && Math.abs(dx) > 30)) || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    if (!drawerOpen && dx > 0 && start.x < 28 && !start.onBar) return setDrawerOpen(true);
    // The open menu: left closes it, right opens 💰 Money.
    if (drawerOpen) {
      if (dx < 0) return setDrawerOpen(false);
      setDrawerOpen(false);
      window.JournalHaptics?.play("edge", 0.6);
      return setMoneyOpen(true);
    }
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

  // Closing search without picking a result (Esc, tapping outside) also drops the query, so no
  // "🔍 query" chip is left behind. Picking a result keeps it, with its highlights.
  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setQuery("");
  }, []);

  const globalSearch = useCallback(async (q: string) => (store ? toResults(await store.search(q), q) : []), [store]);
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

  // Media from the menu back into the note: where it was dropped, or at the cursor.
  const insertMedia: InsertMedia = (files, at) => {
    setDrawerOpen(false);
    const editor = document.querySelector<HTMLElement & { editor?: Editor }>(".tiptap")?.editor;
    if (!editor || !files.length) return;
    const nodes = files.map(mediaNode);
    const pos = at ? editor.view.posAtCoords({ left: at.x, top: at.y })?.pos : undefined;
    if (pos == null) editor.chain().focus().insertContent(nodes).run();
    else editor.chain().focus().insertContentAt(pos, nodes).run();
  };
  // Links tapped inside an embedded note (or anywhere outside an editor).
  const openLinkRef = useRef(handlers.onOpenLink);
  openLinkRef.current = handlers.onOpenLink;
  useEffect(() => {
    const on = (e: Event) => void openLinkRef.current(String((e as CustomEvent).detail ?? ""));
    window.addEventListener("journal:open-link", on);
    return () => window.removeEventListener("journal:open-link", on);
  }, []);
  useEffect(() => {
    const close = () => setDrawerOpen(false);
    window.addEventListener("journal:close-drawer", close);
    return () => window.removeEventListener("journal:close-drawer", close);
  }, []);
  // Mac: tiles dragged from the Media tab into the note.
  useEffect(() => {
    const onDrop = (e: DragEvent) => {
      const raw = e.dataTransfer?.getData(MEDIA_DRAG);
      if (!raw || !store || !(e.target as HTMLElement).closest?.(".tiptap")) return;
      e.preventDefault();
      e.stopPropagation();
      const ids = JSON.parse(raw) as string[];
      void Promise.all(ids.map((id) => store.getFile(id))).then((f) => insertMedia(f.filter((x): x is NonNullable<typeof x> => !!x), { x: e.clientX, y: e.clientY }));
    };
    document.addEventListener("drop", onDrop, true);
    return () => document.removeEventListener("drop", onDrop, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store]);

  const infoTabs = (
    <InfoTabs
      onInsertMedia={route.kind === "day" ? insertMedia : undefined}
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

  // The menu, like Obsidian's: a row of tools on top, lists in the middle, sync and settings pinned at the bottom.
  const menuRibbon = (
    <div className="menu-ribbon" role="toolbar" aria-label="Tools">
      <button type="button" onClick={() => (setDrawerOpen(false), setSearchOpen(true))} title="Search" aria-label="Search">🔍</button>
      <button type="button" onClick={() => (setDrawerOpen(false), setGraphOpen(true))} title="Graph view" aria-label="Graph view">🕸</button>
      <button type="button" onClick={() => (setDrawerOpen(false), setMindOpen(true))} title="Mind map" aria-label="Mind map">🧠</button>
      <button type="button" onClick={() => (setDrawerOpen(false), openTimelines())} title="Timelines" aria-label="Timelines">⏳</button>
      <button type="button" onClick={() => void openNexus()} title="Nexus: this note's history" aria-label="Nexus">⑂</button>
      <button type="button" onClick={async () => (setDrawerOpen(false), await flush(), setChatOpen(true))} title="Chat view" aria-label="Chat view">💬</button>
    </div>
  );
  const menuFooter = (
    <div className="menu-footer">
      <SyncChip status={sync.status} live={sync.live} direct={sync.direct} onOpen={() => void openNexus("sync")} />
      <div className="menu-footer-row">
        <button type="button" onClick={() => (setDrawerOpen(false), void backUpNow())} title="Back up now">💾 Back up</button>
        <RestoreButton store={store} onBeforeRestore={flush} />
        <button type="button" className="menu-settings" onClick={() => (setDrawerOpen(false), setSettingsOpen(true))} title="Settings" aria-label="Settings">⚙︎</button>
      </div>
    </div>
  );

  return (
    <div className="app" onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}>
      <aside className="sidebar">
        {menuRibbon}
        {store && (
          <MenuSections
            sections={{
              money: <MoneyGlance store={store} refreshKey={syncTick} onOpen={() => setMoneyOpen(true)} />,
              projects: <ProjectList store={store} refreshKey={`${syncTick}:${days.length}:${route.kind}`} onOpen={(t) => void handlers.onOpenLink(t)} />,
              days: <DaysList store={store} days={days} day={day} today={today} refreshKey={syncTick} onPick={goTo} />,
            }}
          />
        )}
        {menuFooter}
      </aside>

      <main className="page" inert={overlayOpen || undefined}>
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
              <h1>
                {dayTitle(day)}
                <RelativeTime day={day} today={today} />
              </h1>
              <button type="button" onClick={() => goTo(addDays(day, 1))} aria-label="Next day">›</button>
              {day !== today && (
                <button type="button" className="today" onClick={() => goTo(today)}>Today</button>
              )}
              <span className="status">{status}</span>
              <button type="button" className="routine-button" onClick={() => setRoutineOpen(true)} title="Routine and habits" aria-label="Routine">
                🧭
              </button>
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
              compact={calendarCollapsed && calendarCompact}
              onToggle={(open) => {
                const next = open ?? calendarCollapsed;
                if (next) openedAt.current = Date.now();
                setCalendarCompact(false);
                setCalendarCollapsed(!next);
              }}
              onPick={goTo}
              onOpenYear={openYear}
              below={
                <>
                  {store && <TodayAgenda store={store} view={routine} onOpenRoutine={() => setRoutineOpen(true)} />}
                  <Upcoming inMonth pages={upcoming.filter((r) => r.day !== day)} onPick={goTo} onAction={onReminderAction} />
                </>
              }
              actions={
                <>
                  <button type="button" onClick={() => setDrawerOpen(true)} aria-label="Open menu">☰</button>
                  <button type="button" onClick={() => setSearchOpen(true)} aria-label="Search">🔍</button>
                  <button type="button" onClick={() => setRoutineOpen(true)} aria-label="Routine">🧭</button>
                  <button type="button" onClick={async () => (await flush(), setChatOpen(true))} aria-label="Chat view">💬</button>
                </>
              }
            />
            {/* Reminders only look ahead: a day's notes are on that day's page once it comes. */}

            {page === undefined || loadedDay !== day ? (
              <p className="loading">Loading…</p>
            ) : (
              // Only a real tap into the text shrinks the calendar; opening a day (which focuses
              // the editor by itself) keeps the month open. On click, not pointerdown: shrinking it as the
              // finger lands moved the text up under the finger before the tap was placed, so the caret
              // went somewhere else (in a code block: always its first line).
              <div onClick={() => setCalendarCollapsed(true)}>
                <JournalEditor
                  key={`${day}:${pageVersion}`}
                  // The latest text, not the copy loaded when the day opened: coming back from a
                  // linked page (or search, tags…) remounts the editor and must show what was typed.
                  initialContent={content}
                  onChange={onChange}
                  liveKey={`day:${day}`}
                  onReminder={pickReminderDay}
                  autofocus={!previewNext.current && restoring.current == null}
                  pastDay={day < today}
                  onReady={(t) => {
                    setText(t);
                    if (previewNext.current) {
                      previewNext.current = false;
                      requestAnimationFrame(() => window.scrollTo({ top: document.documentElement.scrollHeight }));
                    }
                    // A new reminder with a time: "⏰ 15:00 " at the end, the cursor after it.
                    const insert = pendingInsert.current;
                    if (insert) {
                      pendingInsert.current = null;
                      requestAnimationFrame(() => {
                        const editor = document.querySelector<HTMLElement & { editor?: Editor }>(".tiptap")?.editor;
                        if (!editor) return;
                        const last = editor.state.doc.lastChild;
                        const chain = editor.chain().focus("end");
                        (last && last.isTextblock && last.content.size === 0 ? chain : chain.splitBlock()).insertContent(insert).run();
                        window.JournalShare?.showKeyboard();
                      });
                    }
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
            {store && loadedDay === day && (
              <BacklinksFooter store={store} target={day} exclude={dayBlockId(day)} handlers={handlers} refreshKey={`${syncTick}:${days.length}`} />
            )}
          </>
        )}
      </main>

      <aside className="links-panel">{infoTabs}</aside>
      {!touch && !sidebarHidden && <PanelResizer side="left" />}
      {!touch && sidebarHidden && <SidebarEdge onShow={toggleSidebar} />}
      {!touch && <PanelResizer side="right" />}

      <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)} top={menuRibbon} bottom={menuFooter}>
        {drawerShown && store && (
          <MenuSections
            sections={{
              money: <MoneyGlance store={store} refreshKey={syncTick} onOpen={() => (setDrawerOpen(false), setMoneyOpen(true))} />,
              projects: (
                <ProjectList
                  store={store}
                  refreshKey={`${syncTick}:${days.length}:${route.kind}`}
                  onOpen={(t) => {
                    setDrawerOpen(false);
                    void handlers.onOpenLink(t);
                  }}
                />
              ),
              days: (
                <DaysList
                  store={store}
                  days={days}
                  day={day}
                  today={today}
                  refreshKey={syncTick}
                  onPick={(d) => {
                    setDrawerOpen(false);
                    void goTo(d);
                  }}
                />
              ),
              info: infoTabs,
            }}
          />
        )}

      </Drawer>

      {searchOpen && <SearchPanel query={query} onQuery={setQuery} results={results} onPick={openHit} onClose={closeSearch} />}

      {find && find.where === (route.kind === "page" ? `page:${route.page.title}` : route.kind === "day" ? day : "") && (
        <FindBar index={find.index} count={find.count} onMove={(index) => setFind({ ...find, index })} onClose={() => setFind(null)} />
      )}

      {nexus && store && (
        <NexusView
          store={store}
          target={nexus}
          tab={nexusTab}
          sync={<SyncStatus status={sync.status} live={sync.live} direct={sync.direct} onSync={() => void sync.syncNow()} onChooseFolder={() => void sync.chooseFolder()} onConnect={sync.connect} />}
          send={<DropPanel linked={!!sync.direct} onConnect={sync.connect ? () => void sync.connect() : undefined} onAddToToday={addDropToToday} />}
          onClose={() => setNexus(null)}
          onRestored={async () => {
            if (nexus.kind === "page") setRoute({ kind: "page", page: await store.ensurePage(nexus.title) });
            else setPageVersion((n) => n + 1);
            setSyncTick((n) => n + 1);
            setNexus(null);
          }}
        />
      )}
      {store && <TimelinesHost store={store} onOpenDay={(d) => void goTo(d)} />}
      {mindOpen && store && (
        <MindMapView store={store} today={today} onClose={() => setMindOpen(false)} onOpenDay={(d) => (setMindOpen(false), void goTo(d))} onOpenPage={(t) => (setMindOpen(false), void handlers.onOpenLink(t))} />
      )}
      {graphOpen && store && (
        <GraphView
          store={store}
          onMindMap={() => (setGraphOpen(false), setMindOpen(true))}
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
      <QuickLogSetup />
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
      {touch && store && (
        <NavIsland
          away={overlayOpen || routineOpen || moneyOpen || !!dayPicker}
          tabs={tabs}
          today={today}
          canBack={activeTab(tabs).index > 0}
          canForward={activeTab(tabs).index < activeTab(tabs).history.length - 1}
          onBack={() => step(-1)}
          onForward={() => step(1)}
          onHome={goHome}
          onHomeDouble={writeAtEnd}
          onShiftDay={(n, final) => {
            // Days from the one open when the stick was taken; the note follows, read-only until tapped.
            joyBase.current ??= route.kind === "day" ? day : today;
            const next = addDays(joyBase.current, n);
            const same = next === joyShown.current && route.kind === "day";
            joyShown.current = final ? null : next;
            if (final) joyBase.current = null;
            if (same) return;
            (document.activeElement as HTMLElement | null)?.blur?.();
            window.JournalShare?.hideKeyboard?.();
            // Opens to read, like a swipe to another day: no focus, no keyboard.
            previewNext.current = true;
            void goTo(next);
          }}
          onSearch={() => setTitleSearchOpen(true)}
          onSearchHistory={() => {
            (document.activeElement as HTMLElement | null)?.blur?.();
            window.JournalShare?.hideKeyboard?.();
            setTitleHistory(true);
            setTitleSearchOpen(true);
          }}
          onTabs={() => setTabsOpen(true)}
          onSwitchTab={switchToTab}
          onNewTab={newTodayTab}
          actions={islandActions}
        />
      )}
      {!touch && (
        <MacTabBar
          tabs={tabs}
          today={today}
          canBack={activeTab(tabs).index > 0}
          canForward={activeTab(tabs).index < activeTab(tabs).history.length - 1}
          onBack={() => step(-1)}
          onForward={() => step(1)}
          onSwitch={switchToTab}
          onClose={(id) => {
            const next = closeTab(tabs, id);
            setTabs(next);
            if (id === tabs.active) openLoc(currentLoc(activeTab(next)));
          }}
          onNew={() => {
            setTabs((t) => openTab(t, { kind: "day", day: today }));
            void goTo(today);
          }}
        />
      )}
      {titleSearchOpen && (
        <TitleSearch
          pages={pageNames}
          days={days}
          today={today}
          history={titleHistory}
          onTextSearch={(q) => {
            setTitleSearchOpen(false);
            setQuery(q);
            setSearchOpen(true);
          }}
          search={globalSearch}
          onPickHit={(hit, match) => {
            setTitleSearchOpen(false);
            void openHit(hit, match);
          }}
          onClose={() => setTitleSearchOpen(false)}
          onOpen={(hit, newTab) => {
            setTitleSearchOpen(false);
            const l: Loc = hit.kind === "day" ? { kind: "day", day: hit.key } : { kind: "page", title: hit.key };
            if (newTab) setTabs((t) => openTab(t, l));
            openLoc(l);
          }}
        />
      )}
      {tabsOpen && (
        <TabSwitcher
          tabs={tabs}
          today={today}
          onDismiss={() => setTabsOpen(false)}
          onSwitch={(id) => {
            setTabsOpen(false);
            switchToTab(id);
          }}
          onClose={(id) => {
            const next = closeTab(tabs, id);
            setTabs(next);
            if (id === tabs.active) openLoc(currentLoc(activeTab(next)));
          }}
          onNew={() => {
            setTabsOpen(false);
            setTabs((t) => openTab(t, { kind: "day", day: today }));
            void goTo(today);
          }}
        />
      )}
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
        onUpcoming={() => setUpcomingOpen(true)}
      />
      {dayPicker && <DayPickerSheet title={dayPicker.title} from={dayPicker.from} withTime={dayPicker.withTime} onPick={dayPicker.onPick} onClose={() => setDayPicker(null)} />}
      {routineOpen && store && <RoutinePanel store={store} onClose={() => setRoutineOpen(false)} />}
      {moneyOpen && store && <FinancePanel store={store} onClose={() => setMoneyOpen(false)} onOpenDay={(d) => void goTo(d)} />}
      <UpcomingPanel
        open={upcomingOpen}
        pages={upcoming}
        onAction={onReminderAction}
        onPick={(d) => {
          setUpcomingOpen(false);
          setYearOpen(false);
          void goTo(d);
        }}
        onClose={() => setUpcomingOpen(false)}
      />
    </div>
  );
}

export default App;
