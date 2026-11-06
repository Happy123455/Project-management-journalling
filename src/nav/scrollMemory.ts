/**
 * Where each tab was scrolled to on each note, so coming back to a tab (or back/forward in it) shows
 * the same part of the note. Kept on this device; only the newest few hundred places are kept.
 */
const KEY = "journal.tabScroll";
const MAX = 300;
let mem: Record<string, number> | null = null;

const load = () => {
  if (mem) return mem;
  try {
    mem = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, number>;
  } catch {
    mem = {};
  }
  return mem;
};
let saveTimer: number | undefined;
const save = () => {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try {
      const entries = Object.entries(load());
      if (entries.length > MAX) mem = Object.fromEntries(entries.slice(-MAX));
      localStorage.setItem(KEY, JSON.stringify(mem));
    } catch {
      // Only a convenience.
    }
  }, 400);
};

export const scrollKey = (tabId: string, loc: string) => `${tabId}|${loc}`;

export function rememberScroll(key: string, y: number) {
  const m = load();
  delete m[key];
  m[key] = Math.max(0, Math.round(y));
  save();
}

export function recallScroll(key: string): number | undefined {
  return load()[key];
}

/** Scrolls to `y` once the note has grown tall enough (it loads after the switch), for up to ~2 s. */
export function restoreScroll(y: number, done?: () => void) {
  const until = performance.now() + 2000;
  const step = () => {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    if (max >= y - 2 || performance.now() > until) {
      window.scrollTo({ top: y });
      // Images and embeds can still push things around: settle once more.
      window.setTimeout(() => {
        if (Math.abs(window.scrollY - y) > 4) window.scrollTo({ top: y });
        done?.();
      }, 250);
      return;
    }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
