import { useEffect, useState, type ReactNode } from "react";
import { dayTitle } from "../lib/timestamp";
import { notSpending, rupees } from "../lib/finance";
import { loadTxns } from "../finance/capture";
import { loadProjectTasks, setRolledTask, type RolledTask } from "../projects/rollup";
import { showError } from "../lib/toast";
import type { JournalStore, NamedPage } from "../store";

/**
 * The menu's sections (Money, Projects, Days, Links/Tags/Media), each folding on its header and
 * all of them arranged with ✎ Edit: renamed, moved up or down, hidden. Kept on this device.
 */
export type MenuKey = "money" | "projects" | "days" | "info";
export const MENU_KEYS: MenuKey[] = ["money", "projects", "days", "info"];
const DEFAULT_NAMES: Record<MenuKey, string> = { money: "Money", projects: "Projects", days: "Days", info: "Links · Tags · Media" };
const ICONS: Record<MenuKey, string> = { money: "💰", projects: "📌", days: "📅", info: "🔗" };

export interface MenuPrefs {
  order: MenuKey[];
  hidden: MenuKey[];
  collapsed: MenuKey[];
  names: Partial<Record<MenuKey, string>>;
  /** Days: newest first or oldest first. */
  daysSort: "new" | "old";
  /** Projects left out of the menu (by page id). */
  hiddenProjects: string[];
  /** How many projects the menu shows. */
  projectLimit: number;
  /** Show each project's open tasks under its name. */
  projectTasks: boolean;
}

const KEY = "journal.menu";
const EVENT = "journal:menu-prefs";

export function loadMenuPrefs(): MenuPrefs {
  let v: Partial<MenuPrefs> = {};
  try {
    v = JSON.parse(localStorage.getItem(KEY) ?? "{}");
  } catch {
    v = {};
  }
  const keys = (x: unknown) => (Array.isArray(x) ? x.filter((k): k is MenuKey => MENU_KEYS.includes(k)) : []);
  const order = keys(v.order);
  return {
    order: [...order, ...MENU_KEYS.filter((k) => !order.includes(k))],
    hidden: keys(v.hidden),
    collapsed: keys(v.collapsed),
    names: v.names && typeof v.names === "object" ? v.names : {},
    daysSort: v.daysSort === "old" ? "old" : "new",
    hiddenProjects: Array.isArray(v.hiddenProjects) ? v.hiddenProjects.filter((x) => typeof x === "string") : [],
    projectLimit: Number.isFinite(v.projectLimit) && v.projectLimit! > 0 ? Math.min(30, Math.round(v.projectLimit!)) : 6,
    projectTasks: v.projectTasks !== false,
  };
}

export function saveMenuPrefs(p: MenuPrefs) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    // Only a convenience.
  }
  window.dispatchEvent(new Event(EVENT));
}

/** The menu settings, kept the same in the Mac sidebar and the phone drawer. */
export function useMenuPrefs(): [MenuPrefs, (patch: Partial<MenuPrefs>) => void] {
  const [prefs, setPrefs] = useState(loadMenuPrefs);
  useEffect(() => {
    const on = () => setPrefs(loadMenuPrefs());
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
  return [prefs, (patch) => saveMenuPrefs({ ...loadMenuPrefs(), ...patch })];
}

export const sectionName = (prefs: MenuPrefs, key: MenuKey) => prefs.names[key]?.trim() || DEFAULT_NAMES[key];

/** The sections in their order, each folding, with ✎ Edit to arrange them. */
export function MenuSections({ sections }: { sections: Partial<Record<MenuKey, ReactNode>> }) {
  const [prefs, setPrefs] = useMenuPrefs();
  const [editing, setEditing] = useState(false);
  const keys = prefs.order.filter((k) => sections[k] !== undefined);
  const move = (k: MenuKey, by: number) => {
    const order = [...prefs.order];
    const i = order.indexOf(k);
    const j = i + by;
    if (i < 0 || j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    setPrefs({ order });
  };
  const toggle = (list: "hidden" | "collapsed", k: MenuKey) => setPrefs({ [list]: prefs[list].includes(k) ? prefs[list].filter((x) => x !== k) : [...prefs[list], k] });
  return (
    <div className={`menu-sections${editing ? " editing" : ""}`}>
      <div className="menu-sections-bar">
        <button type="button" className="menu-edit" onClick={() => setEditing(!editing)}>{editing ? "✓ Done" : "✎ Edit menu"}</button>
        {editing && (
          <button type="button" className="menu-edit" onClick={() => saveMenuPrefs({ ...loadMenuPrefs(), order: [...MENU_KEYS], hidden: [], collapsed: [], names: {} })}>
            Reset
          </button>
        )}
      </div>
      {keys.map((k, i) => {
        const hidden = prefs.hidden.includes(k);
        if (hidden && !editing) return null;
        const collapsed = prefs.collapsed.includes(k) && !editing;
        return (
          <section key={k} className={`menu-section menu-${k}${collapsed ? " collapsed" : ""}${hidden ? " hidden-section" : ""}`}>
            <header className="menu-section-head">
              {editing ? (
                <>
                  <input
                    className="menu-rename"
                    value={prefs.names[k] ?? ""}
                    placeholder={DEFAULT_NAMES[k]}
                    aria-label={`Name for ${DEFAULT_NAMES[k]}`}
                    onChange={(e) => setPrefs({ names: { ...prefs.names, [k]: e.target.value } })}
                  />
                  <button type="button" aria-label="Move up" disabled={i === 0} onClick={() => move(k, -1)}>↑</button>
                  <button type="button" aria-label="Move down" disabled={i === keys.length - 1} onClick={() => move(k, 1)}>↓</button>
                  <button type="button" aria-label={hidden ? "Show" : "Hide"} title={hidden ? "Show in the menu" : "Hide from the menu"} onClick={() => toggle("hidden", k)}>
                    {hidden ? "🙈" : "👁"}
                  </button>
                </>
              ) : (
                <button type="button" className="menu-section-toggle" aria-expanded={!collapsed} onClick={() => toggle("collapsed", k)}>
                  <span className="menu-caret" aria-hidden>{collapsed ? "▸" : "▾"}</span>
                  <h2>{ICONS[k]} {sectionName(prefs, k)}</h2>
                </button>
              )}
            </header>
            {!collapsed && !hidden && <div className="menu-section-body">{sections[k]}</div>}
            {editing && k === "projects" && <ProjectsEdit />}
          </section>
        );
      })}
    </div>
  );
}

/** ✎ Edit, Projects: how many show, and whether their tasks show under them. */
function ProjectsEdit() {
  const [prefs, setPrefs] = useMenuPrefs();
  return (
    <div className="menu-projects-edit">
      <label>
        Show up to
        <input type="number" min={1} max={30} value={prefs.projectLimit} onChange={(e) => setPrefs({ projectLimit: Math.max(1, Math.min(30, Number(e.target.value) || 1)) })} />
        projects
      </label>
      <label>
        <input type="checkbox" checked={prefs.projectTasks} onChange={(e) => setPrefs({ projectTasks: e.target.checked })} /> Show their tasks under each one
      </label>
      {prefs.hiddenProjects.length > 0 && (
        <button type="button" onClick={() => setPrefs({ hiddenProjects: [] })}>Show the {prefs.hiddenProjects.length} hidden project{prefs.hiddenProjects.length === 1 ? "" : "s"} again</button>
      )}
    </div>
  );
}

/**
 * Days with something written in them (and today), newest or oldest first. Days that were only
 * opened (an empty page) are left out.
 */
export function DaysList({ store, days, day, today, refreshKey, onPick }: {
  store: JournalStore | null;
  days: string[];
  day: string;
  today: string;
  refreshKey?: unknown;
  onPick: (d: string) => void;
}) {
  const [prefs, setPrefs] = useMenuPrefs();
  const [written, setWritten] = useState<Set<string> | null>(null);
  const [showAll, setShowAll] = useState(false);
  useEffect(() => {
    if (!store) return;
    let live = true;
    void store.wordCounts("0000-01-01", "9999-12-31").then(
      (c) => live && setWritten(new Set(Object.entries(c).filter(([, n]) => n > 0).map(([d]) => d))),
      () => live && setWritten(null),
    );
    return () => {
      live = false;
    };
  }, [store, days.length, refreshKey]);
  const list = [...new Set([today, ...days])].filter((d) => d === today || d === day || !written || written.has(d));
  list.sort((a, b) => (prefs.daysSort === "new" ? b.localeCompare(a) : a.localeCompare(b)));
  const LIMIT = 60;
  const shown = showAll ? list : list.slice(0, LIMIT);
  return (
    <>
      <div className="days-sort" role="radiogroup" aria-label="Order">
        <button type="button" role="radio" aria-checked={prefs.daysSort === "new"} className={prefs.daysSort === "new" ? "active" : ""} onClick={() => setPrefs({ daysSort: "new" })}>
          ↓ Newest first
        </button>
        <button type="button" role="radio" aria-checked={prefs.daysSort === "old"} className={prefs.daysSort === "old" ? "active" : ""} onClick={() => setPrefs({ daysSort: "old" })}>
          ↑ Oldest first
        </button>
        <span className="days-count">{list.length}</span>
      </div>
      <ul className="day-list">
        {shown.map((d) => (
          <li key={d}>
            <button type="button" className={d === day ? "active" : ""} onClick={() => onPick(d)}>
              {d === today ? "Today" : dayTitle(d).replace(/^\w+, /, "")}
            </button>
          </li>
        ))}
      </ul>
      {list.length > LIMIT && (
        <button type="button" className="days-more" onClick={() => setShowAll(!showAll)}>
          {showAll ? "Show fewer" : `Show all ${list.length} days`}
        </button>
      )}
    </>
  );
}

/**
 * Projects with their open tasks right under each name: tick one off from the menu (it's ticked
 * where it's written). In ✎ Edit menu, ✕ leaves a project out of the menu.
 */
export function ProjectList({ store, refreshKey, onOpen }: { store: JournalStore; refreshKey: unknown; onOpen: (title: string) => void }) {
  const [prefs, setPrefs] = useMenuPrefs();
  const [items, setItems] = useState<{ page: NamedPage; tasks: RolledTask[] }[]>([]);
  const [tick, setTick] = useState(0);
  const [openAll, setOpenAll] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    (async () => {
      const projects = (await store.projects()).filter((p) => p.props.project?.status !== "done" && !prefs.hiddenProjects.includes(p.id));
      projects.sort((a, b) => Number(b.props.project?.status === "active") - Number(a.props.project?.status === "active"));
      const rows = [];
      for (const page of projects.slice(0, prefs.projectLimit)) rows.push({ page, tasks: await loadProjectTasks(store, page) });
      if (live) setItems(rows);
    })().catch(() => {});
    return () => {
      live = false;
    };
  }, [store, refreshKey, tick, prefs.projectLimit, prefs.hiddenProjects.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = async (item: RolledTask) => {
    try {
      // Whatever is being typed is saved first, and the open note shows the tick after.
      await window.__journalFlush?.();
      await setRolledTask(store, item, !item.task.checked);
      window.dispatchEvent(new Event("journal:reload-page"));
      setTick((n) => n + 1);
    } catch (e) {
      showError("Couldn't change the task", e);
    }
  };
  if (!items.length) return <p className="hint">No projects yet: “📌 Project” on a page makes one.</p>;
  return (
    <div className="project-list">
      <ul>
        {items.map(({ page, tasks }) => {
          const open = tasks.filter((t) => !t.task.checked);
          const all = openAll.includes(page.id);
          const shown = all ? open : open.slice(0, 4);
          return (
            <li key={page.id} className="project-item">
              <div className="project-row">
                <button type="button" onClick={() => onOpen(page.title)}>
                  <span className={`project-dot status-${page.props.project?.status}`} />
                  <span className="project-name">{page.title}</span>
                  <span className="project-count">{tasks.length ? `${tasks.length - open.length}/${tasks.length}` : ""}</span>
                </button>
                <button type="button" className="project-hide" title="Leave out of the menu" aria-label={`Leave ${page.title} out of the menu`} onClick={() => setPrefs({ hiddenProjects: [...prefs.hiddenProjects, page.id] })}>
                  ✕
                </button>
              </div>
              {prefs.projectTasks && shown.length > 0 && (
                <ul className="project-tasks">
                  {shown.map((t, i) => (
                    <li key={`${t.day ?? t.title}-${t.task.path.join(".")}-${i}`}>
                      <label>
                        <input type="checkbox" checked={t.task.checked} onChange={() => void toggle(t)} />
                        <span>{t.task.text || "(empty task)"}</span>
                      </label>
                    </li>
                  ))}
                  {open.length > 4 && (
                    <li>
                      <button type="button" className="project-tasks-more" onClick={() => setOpenAll(all ? openAll.filter((x) => x !== page.id) : [...openAll, page.id])}>
                        {all ? "Fewer" : `+${open.length - 4} more`}
                      </button>
                    </li>
                  )}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** This month's money at a glance, and the way into 💰 Money (or swipe right on the menu). */
export function MoneyGlance({ store, refreshKey, onOpen }: { store: JournalStore; refreshKey?: unknown; onOpen: () => void }) {
  const [sum, setSum] = useState<{ spent: number; came: number; n: number } | null>(null);
  // Also after each save, so a payment just written shows here without a sync.
  const [saved, setSaved] = useState(0);
  useEffect(() => {
    const on = () => setSaved((n) => n + 1);
    window.addEventListener("journal:saved", on);
    return () => window.removeEventListener("journal:saved", on);
  }, []);
  useEffect(() => {
    let live = true;
    void loadTxns(store)
      .then((txns) => {
        const now = new Date();
        const inMonth = txns.filter((t) => {
          const d = new Date(t.at);
          return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
        });
        if (!live) return;
        setSum({
          spent: inMonth.filter((t) => t.direction === "debit" && !notSpending(t.category)).reduce((n, t) => n + t.amount, 0),
          came: inMonth.filter((t) => t.direction === "credit").reduce((n, t) => n + t.amount, 0),
          n: inMonth.length,
        });
      })
      .catch(() => live && setSum({ spent: 0, came: 0, n: 0 }));
    return () => {
      live = false;
    };
  }, [store, refreshKey, saved]);
  return (
    <button type="button" className="money-glance" onClick={onOpen}>
      <span className="money-glance-nums">
        {sum ? (
          <>
            <span>This month <b>−{rupees(sum.spent, 0)}</b></span>
            <span className="came">+{rupees(sum.came, 0)}</span>
          </>
        ) : (
          <span>…</span>
        )}
      </span>
      <span className="money-glance-go">Open ›</span>
      <span className="hint money-glance-hint">Swipe right on the menu to open it</span>
    </button>
  );
}
