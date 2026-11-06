import React, { useEffect, useRef, useState, type ReactNode } from "react";
import { loadRecent } from "../search/SearchPanel";
import { createPortal } from "react-dom";
import { dayTitle } from "../lib/timestamp";
import { openOutline, setViewMode, useViewMode, viewMode as currentViewMode, type ViewMode } from "../editor/viewMode";
import { matchTitles, parseScope, type TitleHit } from "./titleMatch";
import { highlightParts } from "../lib/search";
import { rememberSearch, type SearchResult } from "../search/SearchPanel";
import type { SearchHit } from "../store";
import { joyLane } from "./joyPrefs";
import { currentLoc, type Loc, type TabsState } from "./tabs";
import { useEscapeToClose } from "../ui/useEscapeToClose";
import { haptic } from "../lib/haptic";

/** Line icons, drawn like the phone's own (thin, rounded). */
const Icon = ({ d, size = 22 }: { d: ReactNode; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {d}
  </svg>
);
const BACK = <path d="M15 5l-7 7 7 7" />;
const FORWARD = <path d="M9 5l7 7-7 7" />;
const SEARCH = (
  <>
    <circle cx="11" cy="11" r="6.5" />
    <path d="M16 16l4.5 4.5" />
  </>
);
const HOME = (
  <>
    <path d="M3.5 11.2L12 4l8.5 7.2" />
    <path d="M6 9.5V19a1 1 0 0 0 1 1h3.5v-5.5h3V20H17a1 1 0 0 0 1-1V9.5" />
  </>
);

const MODE_ICON: Record<ViewMode, string> = { live: "✎", reading: "📖", source: "</>" };
const MODES: { mode: ViewMode; label: string; icon: string }[] = [
  { mode: "reading", label: "View", icon: "📖" },
  { mode: "live", label: "Edit", icon: "✎" },
  { mode: "source", label: "Source", icon: "</>" },
];

export function locLabel(l: Loc, today: string): string {
  if (l.kind === "day") return l.day === today ? "Today" : dayTitle(l.day).replace(/^\w+, /, "");
  if (l.kind === "page") return l.title;
  return `#${l.tag}`;
}

export interface MenuAction {
  icon: string;
  label: string;
  run: () => void;
}

/** How far Home is drawn up before its joystick engages (px). */
const JOY_LIFT = 64;

type Gesture = {
  id: number;
  x0: number;
  y0: number;
  x: number;
  y: number;
  t0: number;
  zone: string;
  mode: "idle" | "swipe" | "up" | "joy" | "quick" | "previews" | "searchHistory";
  timer: number;
  /** The finger moved after a long press opened the picker (else the picker stays for a tap). */
  movedAfter: boolean;
};

const QUICK: { key: ViewMode | "outline"; icon: string; label: string }[] = [
  { key: "reading", icon: "📖", label: "View" },
  { key: "live", icon: "✎", label: "Edit" },
  { key: "source", icon: "</>", label: "Source" },
  { key: "outline", icon: "🗂", label: "Outline" },
];

/**
 * Phone: the floating island at the bottom while not typing (it gives way to the formatting bar
 * as the keyboard comes up). Back / forward, search by note title, a big Home for today's note,
 * tabs and the mode + menu switcher. Gestures on it:
 * - swipe left → right goes forward, right → left goes back; swipe up opens the menu;
 * - hold Home, then draw it up clear of the bottom edge: a joystick that scrolls the note (lean further
 *   for faster, a tick as it goes);
 *   double-tap Home: the end of today's note, ready to write;
 * - swipe up from (or hold) the tabs: tab previews float up, slide onto one and let go to open it;
 * - hold the menu: View / Edit / Source / Outline fan out, slide onto one and let go.
 */
export function NavIsland({ away, tabs, today, canBack, canForward, onBack, onForward, onHome, onHomeDouble, onShiftDay, onSearchHistory, onSearch, onTabs, onSwitchTab, onNewTab, actions }: {
  /** A panel or sheet covers the page: the island tucks away. */
  away: boolean;
  tabs: TabsState;
  today: string;
  canBack: boolean;
  canForward: boolean;
  onBack: () => void;
  onForward: () => void;
  onHome: () => void;
  onHomeDouble: () => void;
  /** Home joystick leaned sideways: `days` from the day it started on (final: let go). */
  onShiftDay?: (days: number, final: boolean) => void;
  /** Hold or swipe up on 🔍: the whole search history. */
  onSearchHistory?: () => void;
  onSearch: () => void;
  onTabs: () => void;
  onSwitchTab: (id: string) => void;
  onNewTab: () => void;
  actions: MenuAction[];
}) {
  const mode = useViewMode();
  const [menu, setMenu] = useState(false);
  const [picker, setPicker] = useState<null | "quick" | "previews">(null);
  const [hover, setHover] = useState<string | null>(null);
  const [joy, setJoy] = useState<number | null>(null);
  const g = useRef<Gesture | null>(null);
  const navRef = useRef<HTMLElement>(null);
  const quietClick = useRef(0);
  const lastHome = useRef(0);
  // armed: the button has been lifted clear of the screen's bottom edge and the stick is live.
  // lift: how far up (px) the button goes, to the middle of the screen's lower third. offX: sideways
  // lean (days), off: up/down lean (scrolling). days: days moved so far, acc: progress to the next one.
  // lane: half-width (px) of the scroll-only lane around Home (Settings → Gestures); side: which line
  // the thumb is past (-1 left, 1 right, 0 inside).
  const joyRun = useRef<{ frame: number; at: number; off: number; offX: number; travel: number; edge: boolean; armed: boolean; lift: number; days: number; acc: number; go: number; lane: number; side: number } | null>(null);
  const [lane, setLane] = useState<{ x: number; w: number; side: number } | null>(null);
  const [joyX, setJoyX] = useState(0);
  const joyMode = useRef<ViewMode | null>(null);
  const [joyDays, setJoyDays] = useState(0);
  const atToday = (() => {
    const l = currentLoc(tabs.tabs.find((t) => t.id === tabs.active) ?? tabs.tabs[0]);
    return l.kind === "day" && l.day === today;
  })();
  const press = (fn: () => void) => () => {
    if (Date.now() - quietClick.current < 450) return;
    haptic("tap", 0.5);
    fn();
  };

  const stopJoy = () => {
    const j = joyRun.current;
    joyRun.current = null;
    if (j) {
      cancelAnimationFrame(j.frame);
      window.clearTimeout(j.go);
      // Let go: the day it was showing is the day that stays open.
      if (j.days) onShiftDay?.(j.days, true);
    }
    setJoy(null);
    setJoyX(0);
    setJoyDays(0);
    setLane(null);
    // Back to writing mode, without focusing the note (tap the text to type).
    if (joyMode.current === "live" && currentViewMode() === "reading") window.setTimeout(() => setViewMode("live"), 80);
    joyMode.current = null;
  };
  const startJoy = (homeEl: HTMLElement | null) => {
    haptic("press", 0.9);
    // Read-only while the stick is held: the keyboard stays down (it shoved the whole window about).
    joyMode.current = currentViewMode();
    (document.activeElement as HTMLElement | null)?.blur?.();
    window.JournalShare?.hideKeyboard?.();
    if (joyMode.current === "live") setViewMode("reading");
    setJoy(0);
    const r = homeEl?.getBoundingClientRect();
    // The button follows the thumb, so it only needs to clear the bottom edge before the stick engages.
    const lift = JOY_LIFT;
    const j = { frame: 0, at: performance.now(), off: 0, offX: 0, travel: 0, edge: false, armed: false, lift, days: 0, acc: 0, go: 0, lane: joyLane(), side: 0 };
    joyRun.current = j;
    // The faint lane lines rise from Home: between them it only scrolls; past one, the day changes.
    if (r) setLane({ x: r.left + r.width / 2, w: j.lane, side: 0 });
    const loop = (now: number) => {
      const dt = Math.min(0.05, (now - j.at) / 1000);
      j.at = now;
      // Inside the lane it only scrolls; past a lane line it changes days (one at once as the line
      // is crossed, then faster the further past it the thumb goes).
      const leanX = Math.abs(j.offX) - j.lane;
      const sideways = leanX > 0;
      const side = sideways ? Math.sign(j.offX) : 0;
      if (side !== j.side) {
        j.side = side;
        setLane((l) => (l ? { ...l, side } : l));
      }
      if (sideways) {
        const rate = Math.min(5, 0.6 + Math.pow(leanX / 50, 1.8) * 2);
        if (j.acc === 0) j.acc = 1;
        else j.acc += rate * dt;
        while (j.acc >= 1) {
          j.acc -= 1;
          j.days += j.offX > 0 ? 1 : -1;
          haptic("tick", Math.min(1, 0.4 + leanX / 120));
          setJoyDays(j.days);
          // The note follows shortly after the steps pause (not one load per day while it races).
          window.clearTimeout(j.go);
          const n = j.days;
          j.go = window.setTimeout(() => joyRun.current === j && onShiftDay?.(n, false), 260);
        }
        if (j.acc === 0) j.acc = 0.0001;
      } else j.acc = 0;
      const lean = Math.abs(j.off) - 8;
      if (j.armed && !sideways && lean > 0) {
        // Fine near the middle, quick at full lean (about a screen a second at 80px).
        const v = Math.sign(j.off) * Math.pow(Math.min(lean, 90) / 82, 1.6) * 2600;
        const before = window.scrollY;
        window.scrollBy(0, v * dt);
        const moved = Math.abs(window.scrollY - before);
        j.travel += moved;
        if (moved < 0.5 && Math.abs(v * dt) > 1) {
          if (!j.edge) haptic("edge", 1);
          j.edge = true;
        } else j.edge = false;
        // A detent every so often, stronger the faster it runs.
        if (j.travel > 140) {
          j.travel = 0;
          haptic("tick", Math.min(1, 0.3 + lean / 110));
        }
      }
      j.frame = requestAnimationFrame(loop);
    };
    j.frame = requestAnimationFrame(loop);
  };

  const pickAt = (x: number, y: number) => {
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    const key = el?.closest<HTMLElement>("[data-pick]")?.dataset.pick ?? null;
    setHover((h) => {
      if (h !== key && key) haptic("tick", 0.6);
      return key;
    });
    return key;
  };
  const runPick = (kind: "quick" | "previews", key: string) => {
    haptic("edge", 0.8);
    if (kind === "previews") return key === "+" ? onNewTab() : onSwitchTab(key);
    if (key === "outline") return openOutline();
    setViewMode(key as ViewMode);
  };
  const closePicker = () => {
    setPicker(null);
    setHover(null);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType === "mouse") return;
    // A gesture whose finger-up never arrived must not block the island for good.
    if (g.current) {
      if (e.timeStamp - g.current.t0 < 15_000 && g.current.id !== e.pointerId) return;
      window.clearTimeout(g.current.timer);
      g.current = null;
      stopJoy();
    }
    // Every later move and the finger-up come to the island, even when the touched icon is swapped
    // out under the finger (Home's icon turns into the joystick's arrows): lost ones froze it before.
    try {
      navRef.current?.setPointerCapture(e.pointerId);
    } catch {
      // Not capturable (already up).
    }
    const zone = (e.target as HTMLElement).closest<HTMLElement>("[data-zone]")?.dataset.zone ?? "bar";
    const gesture: Gesture = { id: e.pointerId, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, t0: e.timeStamp, zone, mode: "idle", timer: 0, movedAfter: false };
    if (zone === "search")
      gesture.timer = window.setTimeout(() => {
        if (g.current !== gesture || gesture.mode !== "idle") return;
        gesture.mode = "searchHistory";
        haptic("press", 0.8);
        onSearchHistory?.();
      }, 380);
    if (zone === "home" || zone === "tabs" || zone === "menu")
      gesture.timer = window.setTimeout(() => {
        if (g.current !== gesture || gesture.mode !== "idle") return;
        if (zone === "home") {
          gesture.mode = "joy";
          startJoy(navRef.current?.querySelector<HTMLElement>(".nav-home") ?? null);
        } else {
          gesture.mode = zone === "tabs" ? "previews" : "quick";
          haptic("press", 0.8);
          setPicker(gesture.mode);
        }
      }, 380);
    g.current = gesture;
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const s = g.current;
    if (!s || s.id !== e.pointerId) return;
    s.x = e.clientX;
    s.y = e.clientY;
    const dx = s.x - s.x0;
    const dy = s.y - s.y0;
    if (s.mode === "idle") {
      if (Math.hypot(dx, dy) < 12) return;
      window.clearTimeout(s.timer);
      // Home pressed a moment and then dragged (a thumb rarely holds perfectly still): that's the
      // joystick too, not a swipe. Only a quick flick from Home is a swipe.
      if (s.zone === "home" && e.timeStamp - s.t0 > 170) {
        s.mode = "joy";
        startJoy(navRef.current?.querySelector<HTMLElement>(".nav-home") ?? null);
        s.x0 = s.x;
        s.y0 = s.y;
        return;
      }
      if (s.zone === "search" && dy < -14 && -dy > Math.abs(dx)) {
        // Swipe up on 🔍: every search so far.
        s.mode = "searchHistory";
        haptic("press", 0.7);
        onSearchHistory?.();
      } else if (s.zone === "tabs" && dy < -14 && -dy > Math.abs(dx)) {
        s.mode = "previews";
        s.movedAfter = true;
        haptic("press", 0.7);
        setPicker("previews");
      } else if (Math.abs(dx) > Math.abs(dy)) s.mode = "swipe";
      else if (dy < 0) s.mode = "up";
      else s.mode = "swipe";
      return;
    }
    if (s.mode === "joy") {
      const j = joyRun.current;
      if (!j) return;
      // The button sits under the thumb the whole time. First it's drawn up, away from the bottom
      // edge (nothing scrolls yet); once it's a safe height up the stick engages there.
      j.offX = Math.max(-j.lane - 110, Math.min(j.lane + 110, dx));
      setJoyX(j.offX);
      setJoy(Math.max(-window.innerHeight * 0.7, Math.min(0, dy)));
      if (!j.armed) {
        if (dy > -j.lift) return;
        j.armed = true;
        haptic("edge", 0.9);
      }
      j.off = Math.max(-100, Math.min(100, dy + j.lift));
    } else if (s.mode === "quick" || s.mode === "previews") {
      if (Math.hypot(dx, dy) > 14) s.movedAfter = true;
      pickAt(e.clientX, e.clientY);
    }
  };
  const onPointerUp = (e: React.PointerEvent, cancel = false) => {
    const s = g.current;
    if (!s || s.id !== e.pointerId) return;
    g.current = null;
    window.clearTimeout(s.timer);
    const dx = s.x - s.x0;
    const dy = s.y - s.y0;
    if (s.mode !== "idle") quietClick.current = Date.now();
    if (cancel) {
      stopJoy();
      if (s.movedAfter) closePicker();
      return;
    }
    if (s.mode === "joy") return stopJoy();
    if (s.mode === "quick" || s.mode === "previews") {
      const key = pickAt(e.clientX, e.clientY);
      if (key) {
        closePicker();
        return runPick(s.mode, key);
      }
      // Opened by holding and let go in place: it stays, to be tapped. Slid off: it closes.
      if (s.movedAfter) closePicker();
      return;
    }
    const fast = Math.abs(dx) / Math.max(1, e.timeStamp - s.t0) > 0.4;
    if (s.mode === "swipe" && (Math.abs(dx) > 50 || (fast && Math.abs(dx) > 24))) {
      haptic("edge", 0.7);
      // Left → right is forward, right → left is back.
      if (dx > 0) canForward && onForward();
      else canBack && onBack();
    } else if (s.mode === "up" && dy < -24) {
      haptic("edge", 0.7);
      setMenu(true);
    }
  };
  useEffect(() => () => stopJoy(), []);

  return (
    <>
      <nav
        ref={navRef}
        className={`nav-island${away || menu ? " away" : ""}${joy != null ? " joying" : ""}`}
        aria-label="Navigation"
        inert={away || undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => onPointerUp(e)}
        onPointerCancel={(e) => onPointerUp(e, true)}
        onLostPointerCapture={(e) => g.current?.id === e.pointerId && onPointerUp(e, true)}
        onContextMenu={(e) => e.preventDefault()}
      >
        <div className="nav-side">
          <button type="button" className="nav-btn" disabled={!canBack} onClick={press(onBack)} aria-label="Back">
            <Icon d={BACK} />
          </button>
          <button type="button" className="nav-btn" disabled={!canForward} onClick={press(onForward)} aria-label="Forward">
            <Icon d={FORWARD} />
          </button>
          <button type="button" className="nav-btn" data-zone="search" onClick={press(onSearch)} aria-label="Search everything (hold or swipe up: search history)">
            <Icon d={SEARCH} />
          </button>
        </div>
        <button
          type="button"
          data-zone="home"
          className={`nav-home${atToday ? " at-today" : ""}`}
          style={joy != null ? ({ "--joy": `${joy}px`, "--joy-x": `${joyX}px` } as React.CSSProperties) : undefined}
          onClick={press(() => {
            const now = Date.now();
            if (now - lastHome.current < 320) {
              lastHome.current = 0;
              return onHomeDouble();
            }
            lastHome.current = now;
            onHome();
          })}
          aria-label="Today's note (double-tap: write at its end; hold: scroll)"
        >
          {joy != null ? <span className="nav-joy-arrows" aria-hidden>▲<span>◀<i />▶</span>▼</span> : <Icon d={HOME} size={28} />}
          {joy != null && joyDays !== 0 && <span className="nav-joy-day">{joyDays > 0 ? `+${joyDays}` : joyDays} day{Math.abs(joyDays) === 1 ? "" : "s"}</span>}
        </button>
        <div className="nav-side">
          <button type="button" data-zone="tabs" className="nav-btn nav-tabs" onClick={press(onTabs)} aria-label={`${tabs.tabs.length} tabs`}>
            <span className="nav-tab-count">{tabs.tabs.length}</span>
          </button>
          <button type="button" data-zone="menu" className={`nav-btn nav-mode${menu ? " open" : ""}`} onClick={press(() => setMenu(!menu))} aria-label="Mode and menu" aria-expanded={menu}>
            <span className="nav-mode-icon">{MODE_ICON[mode]}</span>
            <span className="nav-burger" aria-hidden>
              <i />
              <i />
              <i />
            </span>
          </button>
        </div>
      </nav>
      {lane &&
        createPortal(
          <div className={`joy-lane${lane.side < 0 ? " past-left" : lane.side > 0 ? " past-right" : ""}`} style={{ left: lane.x - lane.w, width: lane.w * 2 }} aria-hidden />,
          document.body,
        )}
      {menu && <ModeMenu mode={mode} actions={actions} onClose={() => setMenu(false)} />}
      {picker === "quick" && <QuickPicker mode={mode} hover={hover} onPick={(k) => (closePicker(), runPick("quick", k))} onClose={closePicker} />}
      {picker === "previews" && <TabPreviews tabs={tabs} today={today} hover={hover} onPick={(k) => (closePicker(), runPick("previews", k))} onClose={closePicker} />}
    </>
  );
}

/** Held menu: four choices fanned out above it; slide onto one and let go (or tap one). */
function QuickPicker({ mode, hover, onPick, onClose }: { mode: ViewMode; hover: string | null; onPick: (k: string) => void; onClose: () => void }) {
  useEscapeToClose(onClose);
  return createPortal(
    <>
      <div className="nav-pick-backdrop" onClick={onClose} />
      <div className="nav-quick" role="menu" aria-label="Mode">
        {QUICK.map((q, i) => (
          <button
            key={q.key}
            type="button"
            role="menuitem"
            data-pick={q.key}
            className={`${hover === q.key ? "hover" : ""}${mode === q.key ? " current" : ""}`}
            style={{ "--i": i } as React.CSSProperties}
            onClick={() => onPick(q.key)}
          >
            <span aria-hidden>{q.icon}</span>
            {q.label}
          </button>
        ))}
      </div>
    </>,
    document.body,
  );
}

/** Tabs as floating cards above the tab button: slide onto one and let go (or tap one). */
function TabPreviews({ tabs, today, hover, onPick, onClose }: { tabs: TabsState; today: string; hover: string | null; onPick: (k: string) => void; onClose: () => void }) {
  useEscapeToClose(onClose);
  const list = [...tabs.tabs].reverse().slice(0, 8);
  return createPortal(
    <>
      <div className="nav-pick-backdrop" onClick={onClose} />
      <div className="nav-previews" role="menu" aria-label="Tabs">
        <button type="button" data-pick="+" className={`nav-preview new${hover === "+" ? " hover" : ""}`} onClick={() => onPick("+")}>
          ＋ New tab
        </button>
        {list.map((t, i) => {
          const l = currentLoc(t);
          return (
            <button
              key={t.id}
              type="button"
              data-pick={t.id}
              className={`nav-preview${hover === t.id ? " hover" : ""}${t.id === tabs.active ? " active" : ""}`}
              style={{ "--i": i } as React.CSSProperties}
              onClick={() => onPick(t.id)}
            >
              <span className="nav-preview-kind" aria-hidden>{l.kind === "day" ? "📅" : l.kind === "page" ? "📄" : "#"}</span>
              <span className="nav-preview-title">{locLabel(l, today)}</span>
              {t.history.length > 1 && <span className="nav-preview-steps">{t.index + 1}/{t.history.length}</span>}
            </button>
          );
        })}
      </div>
    </>,
    document.body,
  );
}

/** View / Edit / Source, then the app's places (menu, outline, routine…). */
function ModeMenu({ mode, actions, onClose }: { mode: ViewMode; actions: MenuAction[]; onClose: () => void }) {
  useEscapeToClose(onClose);
  return createPortal(
    <>
      <div className="nav-sheet-backdrop" onClick={onClose} />
      <div className="nav-menu" role="menu">
        <div className="nav-modes" role="radiogroup" aria-label="Mode">
          {MODES.map((m) => (
            <button
              key={m.mode}
              type="button"
              role="radio"
              aria-checked={mode === m.mode}
              className={mode === m.mode ? "active" : ""}
              onClick={() => {
                setViewMode(m.mode);
                onClose();
              }}
            >
              <span aria-hidden>{m.icon}</span> {m.label}
            </button>
          ))}
        </div>
        <div className="nav-menu-grid">
          <button
            type="button"
            onClick={() => {
              onClose();
              openOutline();
            }}
          >
            <span aria-hidden>🗂</span>
            Outline
          </button>
          {actions.map((a) => (
            <button
              key={a.label}
              type="button"
              onClick={() => {
                onClose();
                a.run();
              }}
            >
              <span aria-hidden>{a.icon}</span>
              {a.label}
            </button>
          ))}
        </div>
      </div>
    </>,
    document.body,
  );
}

/** Find a note by its title only (days and named pages), and open it here or in a new tab. */
const TITLE_HISTORY = "journal.titleHistory";
type Past = { kind: "day" | "page" | "text"; key: string; label: string; at: number };
function pastSearches(): Past[] {
  try {
    const v = JSON.parse(localStorage.getItem(TITLE_HISTORY) ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
function rememberTitle(h: TitleHit) {
  try {
    const next = [{ kind: h.kind, key: h.key, label: h.label, at: Date.now() }, ...pastSearches().filter((p) => !(p.kind === h.kind && p.key === h.key))].slice(0, 100);
    localStorage.setItem(TITLE_HISTORY, JSON.stringify(next));
  } catch {
    // Not kept.
  }
}

export function TitleSearch({ pages, days, today, onOpen, onClose, history = false, onTextSearch, search, onPickHit }: {
  pages: () => Promise<string[]>;
  days: string[];
  today: string;
  onOpen: (hit: TitleHit, newTab: boolean) => void;
  onClose: () => void;
  /** Opened by holding / swiping up on 🔍: the history shows first and the keyboard stays down. */
  history?: boolean;
  /** A past text search tapped: search the notes' text for it again. */
  onTextSearch?: (q: string) => void;
  /** Searches what the notes say (and file names): the same search as the 🔎 panel. */
  search?: (q: string) => Promise<SearchResult[]>;
  /** A text match tapped: open it at that match. */
  onPickHit?: (hit: SearchHit, match: number) => void;
}) {
  const [q, setQ] = useState("");
  const [past, setPast] = useState<Past[]>(() => {
    // Notes opened from here, and text searches (the 🔎 panel's), newest first.
    const titles = pastSearches();
    const texts = loadRecent().map((t, i) => ({ kind: "text" as const, key: t, label: t, at: -i }));
    return [...titles, ...texts];
  });
  const open = (h: TitleHit, newTab: boolean) => {
    rememberTitle(h);
    onOpen(h, newTab);
  };
  const [names, setNames] = useState<string[]>([]);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let live = true;
    void pages().then((p) => live && setNames(p), () => {});
    if (!history) input.current?.focus();
    return () => {
      live = false;
    };
  }, [pages]);
  useEscapeToClose(onClose);
  // A global search: titles first, then everything the notes say. "file:(…)" (or title:, day:,
  // page:) looks only there.
  const { scope, text } = parseScope(q);
  const titleHits = scope === "file" ? [] : matchTitles(text, names, days, today).filter((h) => scope === "all" || scope === "title" || h.kind === scope);
  const hits = scope === "all" ? titleHits.slice(0, 6) : titleHits;
  const [found, setFound] = useState<SearchResult[] | null>(null);
  useEffect(() => {
    if (!search || !text || scope === "title") return setFound(null);
    let live = true;
    const t = window.setTimeout(() => void search(text).then((r) => live && setFound(r.filter((x) => scope === "all" || x.hit.kind === scope)), () => {}), 220);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [search, text, scope]);
  const pickHit = (hit: SearchHit, match: number) => {
    rememberSearch(q);
    onPickHit?.(hit, match);
  };
  return createPortal(
    <>
      <div className="search-backdrop" onClick={onClose} />
      <div className="search-panel title-search" role="dialog" aria-label="Find a note">
        <div className="search-bar">
          <span aria-hidden>🔍</span>
          <input
            ref={input}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search everything… (file: for files)"
            enterKeyHint="go"
            onKeyDown={(e) => e.key === "Enter" && (hits[0] ? open(hits[0], false) : found?.[0] && pickHit(found[0].hit, 0))}
            aria-label="Search"
          />
          <button type="button" className="search-clear" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <p className="search-summary">
          {q.trim()
            ? `${scope === "all" ? "" : `Only ${scope === "file" ? "files" : scope === "title" ? "titles" : `${scope}s`} · `}${hits.length ? `${hits.length} by title` : ""}${hits.length && found?.length ? " · " : ""}${found?.length ? `${found.length} in ${scope === "file" ? "files" : "notes"}` : ""}${!hits.length && !found?.length ? (found ? "No matches" : "Searching…") : ""}`
            : past.length
              ? `Search history · ${past.length}`
              : "Everything: titles, text, #tags, files. file:(…) for files only"}
        </p>
        {!q.trim() && past.length > 0 && (
          <ul className="search-results search-history">
            {past.map((p) => (
              <li key={`${p.kind}:${p.key}`} className="title-hit">
                <button
                  type="button"
                  className="search-result"
                  onClick={() => (p.kind === "text" ? onTextSearch?.(p.key) : open({ kind: p.kind, key: p.key, label: p.label } as TitleHit, false))}
                >
                  <span className="search-where">
                    <span>{p.kind === "text" ? "🔎 Text" : p.kind === "day" ? "📅 Day" : "📄 Page"}</span>
                  </span>
                  <span className="title-hit-label">{p.label}</span>
                </button>
              </li>
            ))}
            <li>
              <button
                type="button"
                className="search-history-clear"
                onClick={() => {
                  try {
                    localStorage.removeItem(TITLE_HISTORY);
                    localStorage.removeItem("journal.recentSearches");
                  } catch {
                    // Nothing kept.
                  }
                  setPast([]);
                }}
              >
                Clear search history
              </button>
            </li>
          </ul>
        )}
        <ul className="search-results">
          {hits.map((h) => (
            <li key={`${h.kind}:${h.key}`} className="title-hit">
              <button type="button" className="search-result" onClick={() => open(h, false)}>
                <span className="search-where">
                  <span>{h.kind === "day" ? (h.key === today ? "📅 Today" : "📅 Day") : "📄 Page"}</span>
                </span>
                <span className="title-hit-label">{h.label}</span>
              </button>
              <button type="button" className="title-hit-tab" onClick={() => open(h, true)} aria-label={`Open ${h.label} in a new tab`} title="Open in a new tab">
                ⧉
              </button>
            </li>
          ))}
          {found?.map((r) => (
            <li key={r.hit.kind === "file" ? r.hit.file.id : r.hit.blockId}>
              <div className="search-result" role="button" tabIndex={0} onClick={() => pickHit(r.hit, 0)}>
                <span className="search-where">
                  {r.hit.kind === "file" ? `📎 ${r.hit.file.name}` : r.hit.day ? `📅 ${dayTitle(r.hit.day)}` : `📄 ${r.hit.title}`}
                  {r.count > 0 && <span className="search-count">{r.count}</span>}
                </span>
                {r.hit.kind !== "file" &&
                  r.lines.slice(0, 3).map((l, i) => (
                    <span
                      key={i}
                      className="search-line"
                      onClick={(e) => {
                        e.stopPropagation();
                        pickHit(r.hit, r.lines.slice(0, i).reduce((n, x) => n + x.ranges.length, 0));
                      }}
                    >
                      {highlightParts(l).map((p, k) => (p.hit ? <mark key={k}>{p.text}</mark> : <span key={k}>{p.text}</span>))}
                    </span>
                  ))}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </>,
    document.body,
  );
}

/** Every open tab as a card: tap to switch, ✕ to close, + for a new one on today. */
export function TabSwitcher({ tabs, today, onSwitch, onClose: onCloseTab, onNew, onDismiss }: {
  tabs: TabsState;
  today: string;
  onSwitch: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  onDismiss: () => void;
}) {
  useEscapeToClose(onDismiss);
  return createPortal(
    <>
      <div className="nav-sheet-backdrop" onClick={onDismiss} />
      <div className="nav-tabs-sheet" role="dialog" aria-label="Tabs">
        <header>
          <h2>{tabs.tabs.length} {tabs.tabs.length === 1 ? "tab" : "tabs"}</h2>
          <button type="button" className="nav-new-tab" onClick={onNew}>
            ＋ New tab
          </button>
        </header>
        <ul className="nav-tab-list">
          {[...tabs.tabs].reverse().map((t) => {
            const l = currentLoc(t);
            return (
              <li key={t.id} className={t.id === tabs.active ? "active" : ""}>
                <button type="button" className="nav-tab-card" onClick={() => onSwitch(t.id)}>
                  <span className="nav-tab-kind" aria-hidden>{l.kind === "day" ? "📅" : l.kind === "page" ? "📄" : "#"}</span>
                  <span className="nav-tab-title">{locLabel(l, today)}</span>
                  {t.history.length > 1 && <span className="nav-tab-steps">{t.index + 1}/{t.history.length}</span>}
                </button>
                {tabs.tabs.length > 1 && (
                  <button type="button" className="nav-tab-close" onClick={() => onCloseTab(t.id)} aria-label={`Close ${locLabel(l, today)}`}>
                    ✕
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </>,
    document.body,
  );
}

/**
 * Mac: tabs like Obsidian's, as a compact bar pinned to the bottom of the note column. Back and
 * forward for the active tab, every tab as a pill (click to switch, ✕ or middle-click to close), + for a new one.
 */
export function MacTabBar({ tabs, today, canBack, canForward, onBack, onForward, onSwitch, onClose, onNew }: {
  tabs: TabsState;
  today: string;
  canBack: boolean;
  canForward: boolean;
  onBack: () => void;
  onForward: () => void;
  onSwitch: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
}) {
  return (
    <nav className="mac-tabbar" aria-label="Tabs">
      <button type="button" className="mac-tab-nav" disabled={!canBack} onClick={onBack} aria-label="Back" title="Back">
        <Icon d={BACK} size={16} />
      </button>
      <button type="button" className="mac-tab-nav" disabled={!canForward} onClick={onForward} aria-label="Forward" title="Forward">
        <Icon d={FORWARD} size={16} />
      </button>
      <div className="mac-tabs" role="tablist">
        {tabs.tabs.map((t) => {
          const l = currentLoc(t);
          const label = locLabel(l, today);
          const active = t.id === tabs.active;
          return (
            <div key={t.id} className={`mac-tab${active ? " active" : ""}`} role="tab" aria-selected={active} title={label}>
              <button
                type="button"
                className="mac-tab-open"
                onClick={() => onSwitch(t.id)}
                onAuxClick={(e) => e.button === 1 && tabs.tabs.length > 1 && onClose(t.id)}
              >
                <span aria-hidden>{l.kind === "day" ? "📅" : l.kind === "page" ? "📄" : "#"}</span>
                <span className="mac-tab-title">{label}</span>
              </button>
              {tabs.tabs.length > 1 && (
                <button type="button" className="mac-tab-close" onClick={() => onClose(t.id)} aria-label={`Close ${label}`}>
                  ✕
                </button>
              )}
            </div>
          );
        })}
      </div>
      <button type="button" className="mac-tab-nav mac-tab-new" onClick={onNew} aria-label="New tab" title="New tab (today)">
        ＋
      </button>
    </nav>
  );
}
