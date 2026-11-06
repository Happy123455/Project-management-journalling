import { Component, type ReactNode } from "react";

const CRASH_KEY = "journal.lastCrash";

/** Keeps the last few errors (newest first) so a blank or broken start can be looked into later. */
export function noteCrash(error: unknown, where: string) {
  try {
    const message = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : String(error);
    // Ordinary rejections that are handled elsewhere (an aborted request) aren't crashes.
    if (where === "promise" && /abort|cancel/i.test(message)) return;
    const list = JSON.parse(localStorage.getItem(CRASH_KEY) ?? "[]") as { at: string; where: string; message: string }[];
    list.unshift({ at: new Date().toISOString(), where, message: message.slice(0, 1500) });
    localStorage.setItem(CRASH_KEY, JSON.stringify(list.slice(0, 8)));
  } catch {
    // Storage blocked: nothing to keep it in.
  }
}

/** The kept errors, for Settings or the dev tools (window.__journalCrashes()). */
export function lastCrashes(): { at: string; where: string; message: string }[] {
  try {
    return JSON.parse(localStorage.getItem(CRASH_KEY) ?? "[]");
  } catch {
    return [];
  }
}
(window as unknown as { __journalCrashes?: () => unknown }).__journalCrashes = lastCrashes;

/**
 * When drawing the app fails, React takes everything off the screen, which looked like a blank
 * page on opening. This catches it: it draws the app once more by itself (most such errors come
 * from a moment at start-up, like data still arriving), and after that shows what went wrong with
 * a Reload button. Notes are never at risk: they are saved as they're typed.
 */
export class AppGuard extends Component<{ children: ReactNode }, { error: Error | null; tries: number }> {
  state = { error: null as Error | null, tries: 0 };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    noteCrash(error, "render");
    if (this.state.tries < 1) window.setTimeout(() => this.setState((s) => ({ error: null, tries: s.tries + 1 })), 400);
  }

  render() {
    const { error, tries } = this.state;
    if (!error) return this.props.children;
    if (tries < 1) return <div className="boot-splash app-guard"><span>📔 Dynamic Journal…</span></div>;
    return (
      <div className="app-guard" role="alert">
        <strong>The journal hit a problem while drawing this screen.</strong>
        <p>Your notes are safe. Reloading usually fixes it.</p>
        <pre>{error.message}</pre>
        <button type="button" onClick={() => location.reload()}>↻ Reload</button>
      </div>
    );
  }
}
