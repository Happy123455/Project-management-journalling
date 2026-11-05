import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { dayTitle } from "../lib/timestamp";
import { openOutline, setViewMode, useViewMode, type ViewMode } from "../editor/viewMode";
import { matchTitles, type TitleHit } from "./titleMatch";
import { currentLoc, type Loc, type TabsState } from "./tabs";

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

/**
 * Phone: the floating island at the bottom while not typing (it gives way to the formatting bar
 * as the keyboard comes up). Back / forward, search by note title, a big Home for today's note,
 * tabs and the mode + menu switcher.
 */
export function NavIsland({ away, tabs, today, canBack, canForward, onBack, onForward, onHome, onSearch, onTabs, actions }: {
  /** A panel or sheet covers the page: the island tucks away. */
  away: boolean;
  tabs: TabsState;
  today: string;
  canBack: boolean;
  canForward: boolean;
  onBack: () => void;
  onForward: () => void;
  onHome: () => void;
  onSearch: () => void;
  onTabs: () => void;
  actions: MenuAction[];
}) {
  const mode = useViewMode();
  const [menu, setMenu] = useState(false);
  const atToday = (() => {
    const l = currentLoc(tabs.tabs.find((t) => t.id === tabs.active) ?? tabs.tabs[0]);
    return l.kind === "day" && l.day === today;
  })();
  const press = (fn: () => void) => () => {
    window.JournalHaptics?.play("tap", 0.5);
    fn();
  };
  return (
    <>
      <nav className={`nav-island${away || menu ? " away" : ""}`} aria-label="Navigation" inert={away || undefined}>
        <div className="nav-side">
          <button type="button" className="nav-btn" disabled={!canBack} onClick={press(onBack)} aria-label="Back">
            <Icon d={BACK} />
          </button>
          <button type="button" className="nav-btn" disabled={!canForward} onClick={press(onForward)} aria-label="Forward">
            <Icon d={FORWARD} />
          </button>
          <button type="button" className="nav-btn" onClick={press(onSearch)} aria-label="Find a note by title">
            <Icon d={SEARCH} />
          </button>
        </div>
        <button type="button" className={`nav-home${atToday ? " at-today" : ""}`} onClick={press(onHome)} aria-label="Today's note">
          <Icon d={HOME} size={28} />
        </button>
        <div className="nav-side">
          <button type="button" className="nav-btn nav-tabs" onClick={press(onTabs)} aria-label={`${tabs.tabs.length} tabs`}>
            <span className="nav-tab-count">{tabs.tabs.length}</span>
          </button>
          <button type="button" className={`nav-btn nav-mode${menu ? " open" : ""}`} onClick={press(() => setMenu(!menu))} aria-label="Mode and menu" aria-expanded={menu}>
            <span className="nav-mode-icon">{MODE_ICON[mode]}</span>
            <span className="nav-burger" aria-hidden>
              <i />
              <i />
              <i />
            </span>
          </button>
        </div>
      </nav>
      {menu && <ModeMenu mode={mode} actions={actions} onClose={() => setMenu(false)} />}
    </>
  );
}

/** View / Edit / Source, then the app's places (menu, outline, routine…). */
function ModeMenu({ mode, actions, onClose }: { mode: ViewMode; actions: MenuAction[]; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
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
export function TitleSearch({ pages, days, today, onOpen, onClose }: {
  pages: () => Promise<string[]>;
  days: string[];
  today: string;
  onOpen: (hit: TitleHit, newTab: boolean) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [names, setNames] = useState<string[]>([]);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let live = true;
    void pages().then((p) => live && setNames(p), () => {});
    input.current?.focus();
    return () => {
      live = false;
    };
  }, [pages]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const hits = matchTitles(q, names, days, today);
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
            placeholder="Note title or date…"
            enterKeyHint="go"
            onKeyDown={(e) => e.key === "Enter" && hits[0] && onOpen(hits[0], false)}
            aria-label="Note title"
          />
          <button type="button" className="search-clear" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <p className="search-summary">{q.trim() ? `${hits.length} ${hits.length === 1 ? "note" : "notes"} by title` : "Titles only: days and pages"}</p>
        <ul className="search-results">
          {hits.map((h) => (
            <li key={`${h.kind}:${h.key}`} className="title-hit">
              <button type="button" className="search-result" onClick={() => onOpen(h, false)}>
                <span className="search-where">
                  <span>{h.kind === "day" ? (h.key === today ? "📅 Today" : "📅 Day") : "📄 Page"}</span>
                </span>
                <span className="title-hit-label">{h.label}</span>
              </button>
              <button type="button" className="title-hit-tab" onClick={() => onOpen(h, true)} aria-label={`Open ${h.label} in a new tab`} title="Open in a new tab">
                ⧉
              </button>
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
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onDismiss();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDismiss]);
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
