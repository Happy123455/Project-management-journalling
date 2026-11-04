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

// Errors outside React (a failed import, a promise nobody caught) are kept for the next start.
window.addEventListener("error", (e) => noteCrash(e.error ?? e.message, "window"));
window.addEventListener("unhandledrejection", (e) => noteCrash(e.reason, "promise"));

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>{bubble ? <BubbleApp /> : <AppGuard><App /></AppGuard>}</React.StrictMode>,
);
