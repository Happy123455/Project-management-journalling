import { editorPrefs } from "../lib/editorPrefs";

/**
 * Typing speed guide (Settings → Editor): letters typed in the last couple of seconds are counted,
 * and going over the set characters per second makes the cursor "hot" (red and glowing, the
 * `typing-hot` class on <html>) and gives the phone a short double buzz, at most every 1.5 s, until
 * the pace drops back under the limit.
 */
const WINDOW_MS = 2000;
const BUZZ_EVERY_MS = 1500;
/**
 * One key adds one character (two at most: a letter and the space the keyboard adds after a word).
 * More at once is the keyboard replacing a word (auto-correct, a tapped suggestion, swipe typing), a
 * paste or a template: done for you, not typed, so it doesn't count.
 */
const MAX_PER_KEY = 2;
/** Changes closer together than this are one replacement arriving in pieces, not two keys. */
const SAME_KEY_MS = 30;
let lastKeyAt = 0;

let typed: { at: number; n: number }[] = [];
let hot = false;
let lastBuzz = 0;
let cool: number | undefined;
const listeners = new Set<(hot: boolean) => void>();

/** Characters per second over the last WINDOW_MS (exported for tests). */
export function rate(events: { at: number; n: number }[], now: number): number {
  const recent = events.filter((e) => now - e.at <= WINDOW_MS);
  if (!recent.length) return 0;
  const chars = recent.reduce((s, e) => s + e.n, 0);
  // A short burst is measured over at least 1 s, so two quick letters never count as "fast".
  const span = Math.max(1000, now - recent[0].at);
  return chars / (span / 1000);
}

function setHot(next: boolean) {
  if (next === hot) return;
  hot = next;
  document.documentElement.classList.toggle("typing-hot", hot);
  listeners.forEach((l) => l(hot));
}

function buzz() {
  try {
    if (window.JournalHaptics) window.JournalHaptics.play("warn", 1);
    else navigator.vibrate?.([35, 60, 35]);
  } catch {
    // No vibration here.
  }
}

/** Call with how many characters were just typed. */
export function noteTyped(n: number) {
  if (n <= 0 || n > MAX_PER_KEY) return;
  const at = performance.now();
  const instant = at - lastKeyAt < SAME_KEY_MS;
  lastKeyAt = at;
  if (instant) return;
  const prefs = editorPrefs();
  if (!prefs.typingGuide || !(prefs.maxCps > 0)) return setHot(false);
  const now = Date.now();
  typed = [...typed.filter((e) => now - e.at <= WINDOW_MS), { at: now, n }];
  const fast = rate(typed, now) > prefs.maxCps;
  if (fast) {
    setHot(true);
    if (now - lastBuzz > BUZZ_EVERY_MS) {
      lastBuzz = now;
      buzz();
    }
  } else if (hot && rate(typed, now) <= prefs.maxCps * 0.9) setHot(false);
  // Cools down by itself once the typing slows or stops.
  window.clearTimeout(cool);
  if (hot)
    cool = window.setTimeout(function check() {
      if (rate(typed, Date.now()) <= editorPrefs().maxCps * 0.9) setHot(false);
      else cool = window.setTimeout(check, 250);
    }, 250);
}

export function isTypingHot() {
  return hot;
}

export function onTypingHot(l: (hot: boolean) => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
