// One register for every open microphone (25 Nov, Hapi, twice: "I closed the agent and Talk and
// the assistant, and it's still recording"). The phone showed the app holding the mic in call mode
// with nothing open: a recording whose screen had gone kept running, because only that screen
// knew about it. Now every recording is opened here with an owner, and:
// - closing a screen lets go of everything its owner opened, including a mic still starting
//   (it's closed the moment it opens);
// - a watchdog closes any mic whose owner says it's no longer there;
// - going to the background closes every mic except the ones meant to keep listening (🎧, voice graph).

export interface MicUse {
  /** "talk", "agent:ag12", "assistant:bar"… releaseMics("agent:") lets go of every agent's. */
  owner: string;
  /** Still wanted? Checked every 1.5 s; false closes the mic. */
  alive?: () => boolean;
  /** Keeps listening with the app in the background (🎧 firewall, 🎙️ voice graph). */
  background?: boolean;
}

interface Hold extends MicUse {
  stream: MediaStream;
  kill: (() => void) | null;
  since: number;
}

const holds = new Set<Hold>();
/** Owners let go of (prefix → when): a mic they asked for before then is closed as it opens. */
const released: { prefix: string; at: number; n: number }[] = [];
/** Counts asks and releases, so "released after it was asked" holds even within one millisecond. */
let seq = 0;
let guard: ReturnType<typeof setInterval> | 0 = 0;

export class MicReleased extends Error {
  constructor() {
    super("The microphone was let go before it opened");
    this.name = "AbortError";
  }
}

const isAndroid = () => typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);

/**
 * What to ask the microphone for. Android: no echo cancellation / noise suppression, which put the
 * phone in "call" mode (VOICE_COMMUNICATION: the volume jumped, and the mic looked like a call).
 */
export function micAudio(): MediaTrackConstraints {
  return isAndroid() ? { echoCancellation: false, noiseSuppression: false, autoGainControl: true, channelCount: 1 } : { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
}

const stopStream = (s: MediaStream) => s.getTracks().forEach((t) => t.stop());
const ended = (s: MediaStream) => s.getTracks().every((t) => t.readyState === "ended");

function check() {
  for (const h of [...holds]) {
    if (ended(h.stream)) holds.delete(h);
    else if (h.alive && !safe(h.alive)) close(h, "owner gone");
  }
  if (!holds.size && guard) (clearInterval(guard), (guard = 0));
}

const safe = (f: () => boolean) => {
  try {
    return f();
  } catch {
    return false;
  }
};

function close(h: Hold, why: string) {
  holds.delete(h);
  console.info(`[mic] closing ${h.owner}: ${why}`);
  stopStream(h.stream);
  const k = h.kill;
  h.kill = null;
  try {
    k?.();
  } catch {
    // Its own clean-up failed; the mic is off anyway.
  }
}

export interface MicHandle {
  stream: MediaStream;
  /** What to run if the mic is closed from outside (audio graph, wake lock). */
  onKill(f: () => void): void;
  /** The recording ended normally: off the register. */
  done(): void;
}

/** Opens the microphone for `use.owner` (closed again at once if the owner let go meanwhile). */
export async function openMic(use: MicUse, audio: MediaTrackConstraints = micAudio()): Promise<MicHandle> {
  const asked = ++seq;
  const stream = await navigator.mediaDevices.getUserMedia({ audio });
  const gone = released.some((r) => use.owner.startsWith(r.prefix) && r.n > asked);
  if (gone || (use.alive && !safe(use.alive))) {
    stopStream(stream);
    console.info(`[mic] ${use.owner} let go while it was opening`);
    throw new MicReleased();
  }
  const h: Hold = { ...use, stream, kill: null, since: Date.now() };
  holds.add(h);
  if (!guard) guard = setInterval(check, 1500);
  return {
    stream,
    onKill: (f) => (h.kill = f),
    done: () => {
      holds.delete(h);
      stopStream(stream);
    },
  };
}

/** A stream opened elsewhere (the camera with its sound) watched the same way. */
export function trackCamera(stream: MediaStream, alive: () => boolean) {
  holds.add({ owner: "camera", alive, stream, kill: null, since: Date.now() });
  if (!guard) guard = setInterval(check, 1500);
}

/** Lets go of every mic whose owner starts with `prefix` ("" = all), open or still opening. */
export function releaseMics(prefix = "", why = "released") {
  const now = Date.now();
  released.push({ prefix, at: now, n: ++seq });
  // Only the last minute matters (a getUserMedia never takes that long).
  while (released.length && now - released[0].at > 60_000) released.shift();
  for (const h of [...holds]) if (h.owner.startsWith(prefix)) close(h, why);
  // No mic left: no watchdog ticking either (battery).
  if (!holds.size && guard) (clearInterval(guard), (guard = 0));
}

/** The owners holding a mic now (Settings, tests, the console). */
export const openMics = () => [...holds].map((h) => ({ owner: h.owner, seconds: Math.round((Date.now() - h.since) / 1000) }));

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "hidden") return;
    for (const h of [...holds]) if (!h.background) close(h, "app in the background");
  });
  (window as unknown as { __journalMics?: typeof openMics }).__journalMics = openMics;
}
