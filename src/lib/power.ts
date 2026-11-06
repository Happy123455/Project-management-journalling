/**
 * Battery: what the app does while it's in the background on the phone.
 *
 * Android keeps a backgrounded WebView's JavaScript timers running, so before this every loop in
 * the page (sync checks, presence beats, weather, clocks) kept waking the phone for as long as the
 * app sat in the background (Hapi's phone, 2026-11-03: 1 h 22 min background, 30 min CPU, ~87k
 * Wi-Fi packets in a day). Now:
 * - every loop stops itself while the page is hidden and starts again when it's back;
 * - when the page is hidden, it saves, sends its edits to Drive, and then MainActivity pauses the
 *   page's timers ~30 s after the app left the screen (WebView.pauseTimers), unless something is
 *   playing or recording (read aloud, a voice note, a video), and resumes them on return.
 * Nothing is lost by sleeping: reminders are scheduled with the system, bubble notes wait in the
 * native side, and sync catches up as soon as the app is opened (it runs on return).
 */

declare global {
  interface Window {
    /** MainActivity (Android). */
    JournalPower?: { setBusy(busy: boolean): void };
  }
}

let holds = 0;

/** Keeps the page awake in the background while something needs it (recording, reading aloud). */
export function holdAwake(): () => void {
  holds++;
  report();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds--;
    report();
  };
}

/** True while a video or audio element on the page is playing. */
function mediaPlaying(): boolean {
  for (const m of document.querySelectorAll<HTMLMediaElement>("audio, video")) if (!m.paused && !m.ended && !m.muted) return true;
  return false;
}

export function busyNow(): boolean {
  return holds > 0 || mediaPlaying();
}

function report() {
  try {
    window.JournalPower?.setBusy(busyNow());
  } catch {
    // Not on Android.
  }
}

/**
 * At rest (batch 16): Hapi's phone, 2026-11-06, showed the WebView redrawing ~12 times a second
 * with nobody touching it (CPU 3 h 7 min in a 4 h 13 min day on screen, 48% of the battery):
 * endless CSS animations (sun rays, clouds, stars, the ⚡ Live pulse, scrolling titles) and looping
 * clips each ask for a new frame, and every frame repaints the soft shadows and glass under them.
 * A few seconds after the last touch, key or scroll, html gets .at-rest: every CSS animation is
 * paused (App.css) and looping clips stop (usePlayWhenVisible); the next touch wakes them.
 */
export const REST_EVENT = "journal:rest";
const REST_AFTER_MS = 6000;
let resting = false;
let restTimer = 0;
export const atRest = () => resting;
function setRest(v: boolean) {
  if (v === resting) return;
  resting = v;
  document.documentElement.classList.toggle("at-rest", v);
  window.dispatchEvent(new CustomEvent(REST_EVENT, { detail: v }));
}
function awake() {
  if (resting) setRest(false);
  window.clearTimeout(restTimer);
  restTimer = window.setTimeout(() => !busyNow() && setRest(true), REST_AFTER_MS);
}

let started = false;
/** Tells the Android side whether it may pause the page once it's in the background. */
export function startPowerWatch() {
  if (started || typeof document === "undefined") return;
  started = true;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") report();
  });
  for (const type of ["pointerdown", "keydown", "wheel", "touchstart", "scroll", "input", "focusin"]) window.addEventListener(type, awake, { capture: true, passive: true });
  document.addEventListener("visibilitychange", () => (document.hidden ? setRest(true) : awake()));
  awake();
  // Media starting or stopping while in the background (e.g. a clip ends) updates the answer.
  for (const type of ["play", "pause", "ended"]) document.addEventListener(type, () => document.hidden && report(), true);
}

/** setInterval that skips its runs while the page is hidden (the screen is off or another app is open). */
export function visibleInterval(run: () => void, ms: number): () => void {
  const t = window.setInterval(() => {
    if (document.visibilityState !== "hidden") run();
  }, ms);
  return () => window.clearInterval(t);
}
