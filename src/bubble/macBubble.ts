/** Mac: the floating bubble window (a second, transparent, always-on-top window). Main-window side. */
const KEY = "dynamic-journal.mac-bubble";
export const SHORTCUT = "CommandOrControl+Shift+J";
export const isDesktopApp = () => "__TAURI_INTERNALS__" in window && !window.JournalShare;

export function macBubbleEnabled(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

async function bubbleWindow(create: boolean) {
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const existing = await WebviewWindow.getByLabel("bubble");
  if (existing || !create) return existing;
  const { availableMonitors } = await import("@tauri-apps/api/window");
  const screen = (await availableMonitors())[0];
  const width = screen ? screen.size.width / screen.scaleFactor : 1440;
  return new WebviewWindow("bubble", {
    url: "index.html?bubble=1",
    width: 64,
    height: 64,
    x: width - 96,
    y: 160,
    transparent: true,
    decorations: false,
    shadow: false,
    alwaysOnTop: true,
    visibleOnAllWorkspaces: true,
    skipTaskbar: true,
    resizable: false,
    focus: false,
  });
}

/** Shows or hides the bubble (Settings), and the ⌘⇧J shortcut that opens its capture panel. */
export async function setMacBubble(on: boolean) {
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    // Not remembered, but still applied now.
  }
  const { register, unregister, isRegistered } = await import("@tauri-apps/plugin-global-shortcut");
  if (!on) {
    await (await bubbleWindow(false))?.close();
    if (await isRegistered(SHORTCUT)) await unregister(SHORTCUT);
    return;
  }
  await bubbleWindow(true);
  if (!(await isRegistered(SHORTCUT))) {
    await register(SHORTCUT, async (e) => {
      if (e.state !== "Pressed") return;
      await bubbleWindow(true);
      const { emitTo } = await import("@tauri-apps/api/event");
      await emitTo("bubble", "bubble-expand");
    });
  }
}
