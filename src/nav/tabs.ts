/**
 * Tabs and back/forward for the phone's navigation island. Each tab keeps its own history of the
 * notes opened in it (a day, a named page or a tag), like a browser tab. Kept on this device.
 */
export type Loc = { kind: "day"; day: string } | { kind: "page"; title: string } | { kind: "tag"; tag: string };

export interface Tab {
  id: string;
  history: Loc[];
  /** Where in `history` the tab is now. */
  index: number;
}

export interface TabsState {
  tabs: Tab[];
  active: string;
}

const KEY = "journal.tabs";
const MAX_HISTORY = 50;
export const MAX_TABS = 12;

export const locKey = (l: Loc) => (l.kind === "day" ? `day:${l.day}` : l.kind === "page" ? `page:${l.title.toLowerCase()}` : `tag:${l.tag.toLowerCase()}`);
export const sameLoc = (a: Loc | undefined, b: Loc | undefined) => !!a && !!b && locKey(a) === locKey(b);

let seq = 0;
const newId = () => `t${Date.now().toString(36)}${(seq++).toString(36)}`;

export function initialTabs(start: Loc): TabsState {
  const id = newId();
  return { tabs: [{ id, history: [start], index: 0 }], active: id };
}

export const activeTab = (s: TabsState): Tab => s.tabs.find((t) => t.id === s.active) ?? s.tabs[0];
export const currentLoc = (t: Tab): Loc => t.history[t.index];

const replaceTab = (s: TabsState, tab: Tab): TabsState => ({ ...s, tabs: s.tabs.map((t) => (t.id === tab.id ? tab : t)) });

/** The note on screen changed: it becomes the tab's newest place (anything "forward" is dropped). */
export function visit(s: TabsState, loc: Loc): TabsState {
  const tab = activeTab(s);
  if (sameLoc(currentLoc(tab), loc)) return s;
  const history = [...tab.history.slice(0, tab.index + 1), loc].slice(-MAX_HISTORY);
  return replaceTab({ ...s, active: tab.id }, { ...tab, history, index: history.length - 1 });
}

export const canGo = (s: TabsState, by: -1 | 1) => {
  const t = activeTab(s);
  const i = t.index + by;
  return i >= 0 && i < t.history.length;
};

/** One step back (-1) or forward (1) in the active tab: the new state and the place to show. */
export function go(s: TabsState, by: -1 | 1): { state: TabsState; loc: Loc } | null {
  if (!canGo(s, by)) return null;
  const tab = activeTab(s);
  const next = { ...tab, index: tab.index + by };
  return { state: replaceTab(s, next), loc: currentLoc(next) };
}

/** A new tab showing `loc`, made the active one (the oldest other tab goes when there are too many). */
export function openTab(s: TabsState, loc: Loc): TabsState {
  const id = newId();
  let tabs = [...s.tabs, { id, history: [loc], index: 0 }];
  if (tabs.length > MAX_TABS) tabs = tabs.slice(tabs.length - MAX_TABS);
  return { tabs, active: id };
}

export function switchTab(s: TabsState, id: string): TabsState {
  return s.tabs.some((t) => t.id === id) ? { ...s, active: id } : s;
}

/** Closes a tab; closing the active one moves to its neighbour. The last tab can't be closed. */
export function closeTab(s: TabsState, id: string): TabsState {
  if (s.tabs.length <= 1) return s;
  const i = s.tabs.findIndex((t) => t.id === id);
  if (i < 0) return s;
  const tabs = s.tabs.filter((t) => t.id !== id);
  const active = s.active === id ? tabs[Math.min(i, tabs.length - 1)].id : s.active;
  return { tabs, active };
}

const validLoc = (l: unknown): l is Loc => {
  const x = l as Record<string, unknown> | null;
  if (!x || typeof x !== "object") return false;
  if (x.kind === "day") return typeof x.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(x.day);
  if (x.kind === "page") return typeof x.title === "string" && !!x.title.trim();
  if (x.kind === "tag") return typeof x.tag === "string" && !!x.tag.trim();
  return false;
};

export function loadTabs(start: Loc): TabsState {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as TabsState | null;
    const tabs = (raw?.tabs ?? [])
      .map((t) => ({ id: String(t.id), history: (t.history ?? []).filter(validLoc), index: Number(t.index) }))
      .filter((t) => t.history.length)
      .map((t) => ({ ...t, index: Number.isInteger(t.index) ? Math.max(0, Math.min(t.index, t.history.length - 1)) : t.history.length - 1 }));
    if (!tabs.length) return initialTabs(start);
    const active = tabs.some((t) => t.id === raw!.active) ? raw!.active : tabs[0].id;
    return { tabs, active };
  } catch {
    return initialTabs(start);
  }
}

export function saveTabs(s: TabsState) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Only a convenience.
  }
}
