import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { BubbleApp } from "./bubble/BubbleApp";
import { applyEditorPrefs } from "./lib/editorPrefs";

// The Mac floating bubble opens this same page in its own small window.
const bubble = new URLSearchParams(location.search).has("bubble");
applyEditorPrefs();
if (!bubble) void import("./lib/ambience").then((a) => a.startAmbience());

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>{bubble ? <BubbleApp /> : <App />}</React.StrictMode>,
);
