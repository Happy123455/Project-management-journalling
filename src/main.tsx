import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { BubbleApp } from "./bubble/BubbleApp";
import { applyEditorPrefs } from "./lib/editorPrefs";
import { startPowerWatch } from "./lib/power";
import { applyTheme, followThemeChanges } from "./lib/theme";
import { AppGuard, noteCrash } from "./AppGuard";

// The Mac floating bubble opens this same page in its own small window.
const bubble = new URLSearchParams(location.search).has("bubble");
applyEditorPrefs();
startPowerWatch();
applyTheme();
followThemeChanges();
if (!bubble) void import("./lib/ambience").then((a) => a.startAmbience());

// Remember the look for the next start (index.html puts it back before the first paint).
function keepBootLook() {
  try {
    const root = document.documentElement;
    const cls = [...root.classList].filter((c) => !["booting", "neu-instant", "overlay-open", "kb-bar-on", "typing-hot", "yt-full-open"].includes(c)).join(" ");
    const style = (root.getAttribute("style") ?? "").replace(/(^|;)\s*background:[^;]*/g, "");
    const body = getComputedStyle(document.body);
    const clear = (c: string) => !c || c === "transparent" || /rgba\(.*,\s*0\)$/.test(c);
    const bg = clear(body.backgroundColor) ? getComputedStyle(root).backgroundColor : body.backgroundColor;
    localStorage.setItem("journal.boot", JSON.stringify({ style, cls, light: root.dataset.light, tone: root.dataset.tone, bg: clear(bg) ? undefined : bg, fg: body.color }));
  } catch {
    // Only a nicer start.
  }
}
if (!bubble) {
  document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && keepBootLook());
  window.addEventListener("pagehide", keepBootLook);
  window.setTimeout(keepBootLook, 4000);
  // The app has drawn: back to the real background, transitions and animations.
  window.setTimeout(() => {
    const root = document.documentElement;
    root.style.removeProperty("background");
    root.classList.remove("booting", "neu-instant");
  }, 450);
}

// Errors outside React (a failed import, a promise nobody caught) are kept for the next start.
window.addEventListener("error", (e) => noteCrash(e.error ?? e.message, "window"));
window.addEventListener("unhandledrejection", (e) => noteCrash(e.reason, "promise"));

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>{bubble ? <BubbleApp /> : <AppGuard><App /></AppGuard>}</React.StrictMode>,
);
