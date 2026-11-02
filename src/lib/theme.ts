/**
 * App themes (Settings → Appearance → Theme), like Obsidian's theme picker.
 * The choice is kept on this device and set as `data-theme` on <html>; each theme is a CSS layer
 * over the base look (liquid glass is the base, so it needs no attribute rules of its own).
 * Light or dark still follows the system.
 */
export type ThemeId = "glass" | "neu";

export interface ThemeInfo {
  id: ThemeId;
  name: string;
  hint: string;
}

export const THEMES: ThemeInfo[] = [
  { id: "glass", name: "Liquid glass", hint: "See-through panels, bright rims, weather on the glass" },
  { id: "neu", name: "Soft UI", hint: "Neumorphism: raised and pressed shapes in one soft colour" },
];

const KEY = "journal.theme";
export const DEFAULT_THEME: ThemeId = "glass";

function isTheme(v: unknown): v is ThemeId {
  return THEMES.some((t) => t.id === v);
}

export function currentTheme(): ThemeId {
  try {
    const v = localStorage.getItem(KEY);
    return isTheme(v) ? v : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

export function applyTheme(t: ThemeId = currentTheme()) {
  const root = document.documentElement;
  root.dataset.theme = t;
  // Browser chrome and the Android status bar area match the page.
  const bg = getComputedStyle(root).getPropertyValue("--bg").trim();
  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (bg) {
    if (!meta) {
      meta = document.createElement("meta");
      meta.name = "theme-color";
      document.head.appendChild(meta);
    }
    meta.content = bg;
  }
}

export function setTheme(t: ThemeId): ThemeId {
  try {
    localStorage.setItem(KEY, t);
  } catch {
    // Blocked storage: the theme lasts until the app closes.
  }
  applyTheme(t);
  window.dispatchEvent(new Event("journal:theme"));
  return t;
}

/** Keeps every window (the Mac bubble too) on the same theme when it changes in another one. */
export function followThemeChanges() {
  window.addEventListener("storage", (e) => {
    if (e.key === KEY) applyTheme();
  });
  matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => applyTheme());
}
