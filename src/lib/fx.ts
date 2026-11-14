import { haptic } from "./haptic";

/**
 * Small sound effects and haptics for the deadline bar (Web Audio, no files): soft, short and quiet,
 * like a fingertip on a rubbery surface. On by default; "Sounds & haptics" in a deadline's settings
 * turns them off for every deadline. The audio context is suspended a moment after the last sound so
 * the phone's audio output can sleep (see ambience.ts for why).
 */

export type Fx = "tick" | "snap" | "pick" | "drop" | "done" | "undone" | "open" | "close" | "start" | "stop" | "warn" | "delete" | "nudge";

const KEY = "journal.deadlineFx";
export const fxOn = () => {
  try {
    return localStorage.getItem(KEY) !== "off";
  } catch {
    return true;
  }
};
export const setFxOn = (on: boolean) => {
  try {
    localStorage.setItem(KEY, on ? "on" : "off");
  } catch {
    // Private mode: just this session.
  }
};

let audio: AudioContext | null = null;
let idle = 0;
function ctx(): AudioContext | null {
  try {
    audio ??= new AudioContext({ latencyHint: "interactive" });
    if (audio.state === "suspended") void audio.resume();
    window.clearTimeout(idle);
    idle = window.setTimeout(() => void audio?.suspend(), 1500);
    return audio;
  } catch {
    return null;
  }
}

/** One soft partial: sine with a quick attack and a short decay. */
function tone(a: AudioContext, freq: number, at: number, dur: number, vol: number, glide = 0, type: OscillatorType = "sine") {
  const o = a.createOscillator();
  const g = a.createGain();
  const lp = a.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 2600;
  o.type = type;
  o.frequency.setValueAtTime(freq, at);
  if (glide) o.frequency.exponentialRampToValueAtTime(Math.max(40, freq + glide), at + dur);
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(vol, at + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  o.connect(lp).connect(g).connect(a.destination);
  o.start(at);
  o.stop(at + dur + 0.02);
}

const HAPTIC: Record<Fx, ["tap" | "tick" | "press" | "edge" | "warn", number]> = {
  tick: ["tick", 0.25],
  snap: ["edge", 0.5],
  pick: ["press", 0.55],
  drop: ["tap", 0.5],
  done: ["press", 0.8],
  undone: ["tap", 0.4],
  open: ["tap", 0.35],
  close: ["tick", 0.3],
  start: ["press", 0.7],
  stop: ["press", 0.6],
  warn: ["warn", 0.7],
  delete: ["press", 0.6],
  nudge: ["tick", 0.35],
};

let lastTick = 0;
/** Plays one effect (sound + haptic). Ticks are limited to one every 30 ms while dragging fast. */
export function fx(kind: Fx) {
  if (!fxOn()) return;
  const now = performance.now();
  if ((kind === "tick" || kind === "nudge") && now - lastTick < 30) return;
  if (kind === "tick" || kind === "nudge") lastTick = now;
  const [h, s] = HAPTIC[kind];
  haptic(h, s);
  const a = ctx();
  if (!a) return;
  const t = a.currentTime + 0.005;
  switch (kind) {
    case "tick":
      return tone(a, 1800, t, 0.025, 0.018);
    case "nudge":
      return tone(a, 1200, t, 0.04, 0.03);
    case "snap":
      tone(a, 900, t, 0.05, 0.05);
      return tone(a, 1350, t + 0.012, 0.05, 0.03);
    case "pick":
      return tone(a, 420, t, 0.09, 0.06, 140);
    case "drop":
      return tone(a, 560, t, 0.11, 0.06, -200);
    case "done":
      tone(a, 660, t, 0.14, 0.05);
      tone(a, 880, t + 0.07, 0.16, 0.05);
      return tone(a, 1320, t + 0.14, 0.22, 0.035);
    case "undone":
      return tone(a, 700, t, 0.12, 0.04, -250);
    case "open":
      return tone(a, 480, t, 0.16, 0.035, 260);
    case "close":
      return tone(a, 620, t, 0.12, 0.03, -260);
    case "start":
      tone(a, 520, t, 0.12, 0.05);
      return tone(a, 780, t + 0.09, 0.2, 0.05);
    case "stop":
      tone(a, 780, t, 0.12, 0.045);
      return tone(a, 520, t + 0.09, 0.2, 0.045);
    case "warn":
      tone(a, 330, t, 0.12, 0.05, 0, "triangle");
      return tone(a, 300, t + 0.14, 0.14, 0.05, 0, "triangle");
    case "delete":
      return tone(a, 300, t, 0.18, 0.06, -160, "triangle");
  }
}
