/**
 * Ambience (all optional, Settings › Look and feel):
 * - the colours brighten and dim with the time of day,
 * - the weather shows on the glass: sun rays when sunny, drifting cloud when cloudy, drops
 *   running down the glass when it rains,
 * - glass sounds: a soft "tink" when an element is touched, a breathy swish when a finger slides.
 * Weather comes from Open-Meteo (no key) for the rough location of this internet connection.
 */

export interface AmbienceSettings {
  daylight: boolean;
  weather: boolean;
  sounds: boolean;
}

const KEY = "dynamic-journal.ambience";
const DEFAULTS: AmbienceSettings = { daylight: true, weather: true, sounds: false };

export function ambienceSettings(): AmbienceSettings {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
  } catch {
    return DEFAULTS;
  }
}

export function setAmbienceSettings(patch: Partial<AmbienceSettings>): AmbienceSettings {
  const next = { ...ambienceSettings(), ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Only a preference.
  }
  applyAmbience();
  return next;
}

export type Weather = "clear" | "cloudy" | "rain" | null;

/** Open-Meteo weather codes: 0-1 clear, 2-3/45/48 cloud and fog, 51+ drizzle, rain, snow, storms. */
export function weatherFromCode(code: number): Weather {
  if (code <= 1) return "clear";
  if (code <= 48) return "cloudy";
  return "rain";
}

/** 0 at night, 1 at midday, smooth in between (sunrise ~6:00, sunset ~19:00). */
export function daylightAt(date: Date): number {
  const h = date.getHours() + date.getMinutes() / 60;
  if (h < 5 || h > 20.5) return 0;
  return Math.max(0, Math.sin(((h - 5) / 15.5) * Math.PI));
}

let weather: Weather = null;
let weatherAt = 0;

async function fetchWeather(): Promise<Weather> {
  if (Date.now() - weatherAt < 30 * 60_000) return weather;
  weatherAt = Date.now();
  try {
    const geo = await (await fetch("https://get.geojs.io/v1/ip/geo.json")).json();
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${geo.latitude}&longitude=${geo.longitude}&current=weather_code,is_day`;
    const now = await (await fetch(url)).json();
    weather = weatherFromCode(Number(now.current?.weather_code ?? 0));
  } catch {
    weather = null;
  }
  return weather;
}

let rain: { stop: () => void } | null = null;

/** Drops on the glass: each one sits, swells, then slides down leaving a thin trail. */
function startRain(): { stop: () => void } {
  const canvas = document.createElement("canvas");
  canvas.className = "ambience-rain";
  document.body.appendChild(canvas);
  const ctx = canvas.getContext("2d")!;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  let w = 0;
  let h = 0;
  const size = () => {
    w = canvas.width = Math.round(window.innerWidth * dpr);
    h = canvas.height = Math.round(window.innerHeight * dpr);
  };
  size();
  window.addEventListener("resize", size);
  type Drop = { x: number; y: number; r: number; v: number; wait: number };
  const drops: Drop[] = [];
  const spawn = (): Drop => ({ x: Math.random() * w, y: Math.random() * h * 0.8, r: (1.5 + Math.random() * 3.5) * dpr, v: 0, wait: 40 + Math.random() * 200 });
  for (let i = 0; i < 26; i++) drops.push(spawn());
  let frame = 0;
  let last = 0;
  const tick = (t: number) => {
    frame = requestAnimationFrame(tick);
    // ~30 fps is plenty for drops, and half the work on the phone.
    if (t - last < 33 || document.hidden) return;
    last = t;
    ctx.clearRect(0, 0, w, h);
    for (let i = 0; i < drops.length; i++) {
      const d = drops[i];
      if (d.wait > 0) d.wait--;
      else {
        d.v = Math.min(d.v + 0.08 * dpr, 4 * dpr);
        d.y += d.v;
        d.x += Math.sin(d.y / (30 * dpr)) * 0.3;
        // Trail
        ctx.strokeStyle = "rgba(255,255,255,0.10)";
        ctx.lineWidth = d.r * 0.5;
        ctx.beginPath();
        ctx.moveTo(d.x, d.y - d.v * 6);
        ctx.lineTo(d.x, d.y);
        ctx.stroke();
      }
      // The drop: a lens, bright rim at the bottom, highlight at the top.
      const g = ctx.createRadialGradient(d.x - d.r * 0.3, d.y - d.r * 0.4, d.r * 0.1, d.x, d.y, d.r);
      g.addColorStop(0, "rgba(255,255,255,0.55)");
      g.addColorStop(0.5, "rgba(255,255,255,0.08)");
      g.addColorStop(1, "rgba(255,255,255,0.30)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(d.x, d.y, d.r, d.r * 1.15, 0, 0, Math.PI * 2);
      ctx.fill();
      if (d.y > h + 10) drops[i] = { ...spawn(), y: Math.random() * h * 0.3 };
    }
  };
  frame = requestAnimationFrame(tick);
  return {
    stop: () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", size);
      canvas.remove();
    },
  };
}

const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** Applies the current settings: daylight level, weather class and rain, sounds. */
export function applyAmbience() {
  const s = ambienceSettings();
  const root = document.documentElement;
  if (!document.querySelector(".ambience-layer")) {
    const layer = document.createElement("div");
    layer.className = "ambience-layer";
    document.body.prepend(layer);
  }
  root.style.setProperty("--daylight", s.daylight ? daylightAt(new Date()).toFixed(2) : "0.6");
  root.classList.toggle("ambience-daylight", s.daylight);
  const hour = new Date().getHours();
  root.classList.toggle("sun-low", s.daylight && ((hour >= 6 && hour < 8) || (hour >= 17 && hour < 20)));
  const show = (w: Weather) => {
    root.classList.remove("weather-clear", "weather-cloudy", "weather-rain");
    if (w) root.classList.add(`weather-${w}`);
    const wantRain = w === "rain" && !reducedMotion();
    if (wantRain && !rain) rain = startRain();
    if (!wantRain && rain) (rain.stop(), (rain = null));
  };
  if (s.weather) void fetchWeather().then((w) => show(ambienceSettings().weather ? w : null));
  else show(null);
  glassSounds(s.sounds);
}

let started = false;
/** Starts ambience and keeps it current (every 10 minutes, and when the app comes back). */
export function startAmbience() {
  if (started || typeof window === "undefined") return;
  started = true;
  applyAmbience();
  window.setInterval(applyAmbience, 10 * 60_000);
  document.addEventListener("visibilitychange", () => !document.hidden && applyAmbience());
}

// ───────────── Glass sounds and haptics (Web Audio, no files; phone haptics through MainActivity) ─────────────

declare global {
  interface Window {
    JournalHaptics?: { play(kind: string, strength: number): void };
  }
}

let audio: AudioContext | null = null;
let noise: AudioBuffer | null = null;
let soundsOn = false;

function ctx(): AudioContext | null {
  if (!audio) {
    try {
      audio = new AudioContext({ latencyHint: "interactive" });
      // Pink-ish noise: softer than white, closer to skin on glass.
      noise = audio.createBuffer(1, audio.sampleRate * 2, audio.sampleRate);
      const d = noise.getChannelData(0);
      let b0 = 0, b1 = 0, b2 = 0;
      for (let i = 0; i < d.length; i++) {
        const w = Math.random() * 2 - 1;
        b0 = 0.99765 * b0 + w * 0.099046;
        b1 = 0.963 * b1 + w * 0.2965164;
        b2 = 0.57 * b2 + w * 1.0526913;
        d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2;
      }
    } catch {
      return null;
    }
  }
  if (audio.state === "suspended") void audio.resume();
  return audio;
}

const haptic = (kind: "tap" | "tick" | "press" | "edge", strength: number) => {
  try {
    window.JournalHaptics?.play(kind, strength);
  } catch {
    // No haptics here.
  }
};

/** A fingertip landing on glass: a soft, short knock with a faint glassy ring. */
function tink(onButton: boolean) {
  const a = ctx();
  if (!a || !noise) return;
  const t = a.currentTime + 0.005;
  const knock = a.createBufferSource();
  knock.buffer = noise;
  const lp = a.createBiquadFilter();
  lp.type = "bandpass";
  lp.frequency.value = 1800 + Math.random() * 600;
  lp.Q.value = 1.2;
  const kg = a.createGain();
  kg.gain.setValueAtTime(0, t);
  kg.gain.linearRampToValueAtTime(onButton ? 0.22 : 0.12, t + 0.002);
  kg.gain.exponentialRampToValueAtTime(0.0005, t + 0.035);
  knock.connect(lp).connect(kg).connect(a.destination);
  knock.start(t, Math.random(), 0.05);
  // Two slightly detuned partials: the "glass" in the tap, very quiet.
  for (const f of [2600 + Math.random() * 300, 4100 + Math.random() * 300]) {
    const o = a.createOscillator();
    o.frequency.value = f;
    const g = a.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(onButton ? 0.018 : 0.01, t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0002, t + (onButton ? 0.28 : 0.18));
    o.connect(g).connect(a.destination);
    o.start(t);
    o.stop(t + 0.32);
  }
}

/** A finger sliding on glass: soft friction noise that follows the finger's speed, fading out when it stops. */
let swish: { gain: GainNode; band: BiquadFilterNode; src: AudioBufferSourceNode } | null = null;
let swishIdle = 0;
function slide(speed: number) {
  const a = ctx();
  if (!a || !noise) return;
  if (!swish) {
    const src = a.createBufferSource();
    src.buffer = noise;
    src.loop = true;
    const band = a.createBiquadFilter();
    band.type = "bandpass";
    band.Q.value = 0.9;
    const hp = a.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 600;
    const gain = a.createGain();
    gain.gain.value = 0;
    src.connect(hp).connect(band).connect(gain).connect(a.destination);
    src.start();
    swish = { gain, band, src };
  }
  const t = a.currentTime;
  // px/ms: ~0.2 slow drag, ~2 fast flick.
  const level = Math.min(0.09, 0.015 + speed * 0.03);
  swish.gain.gain.setTargetAtTime(level, t, 0.025);
  swish.band.frequency.setTargetAtTime(900 + Math.min(3200, speed * 1500), t, 0.04);
  window.clearTimeout(swishIdle);
  swishIdle = window.setTimeout(endSlide, 60);
}
function endSlide() {
  window.clearTimeout(swishIdle);
  if (swish && audio) swish.gain.gain.setTargetAtTime(0, audio.currentTime, 0.05);
}

const TOUCHABLE = "button, a, [role=button], input, select, label, .cal-day, .peek-item, .reminder-open, .attach-image-box, .media-grip, .meme-tile";
const TAP_MOVE = 8; // px: more than this and it's a swipe, not a touch
const TAP_WAIT = 90; // ms: a still finger after this long is a touch

/** One finger (or mouse button) at a time: touch → tap sound once it's clearly not a swipe; swipe → only the slide sound. */
let gesture: { x: number; y: number; lx: number; ly: number; lt: number; target: Element | null; swiping: boolean; tapped: boolean; timer: number; travelled: number } | null = null;

function begin(x: number, y: number, target: EventTarget | null) {
  ctx(); // Unlocks audio on the first touch.
  if (gesture) window.clearTimeout(gesture.timer);
  const el = (target as Element | null)?.closest?.(TOUCHABLE) ?? null;
  gesture = { x, y, lx: x, ly: y, lt: performance.now(), target: el, swiping: false, tapped: false, travelled: 0, timer: 0 };
  const g = gesture;
  g.timer = window.setTimeout(() => {
    if (gesture === g && !g.swiping) tap(g);
  }, TAP_WAIT);
}
function tap(g: NonNullable<typeof gesture>) {
  if (g.tapped) return;
  g.tapped = true;
  tink(!!g.target);
  haptic(g.target ? "press" : "tap", g.target ? 0.7 : 0.35);
}
function move(x: number, y: number) {
  const g = gesture;
  if (!g) return;
  const now = performance.now();
  const step = Math.hypot(x - g.lx, y - g.ly);
  const speed = step / Math.max(1, now - g.lt);
  g.lx = x;
  g.ly = y;
  g.lt = now;
  if (!g.swiping && Math.hypot(x - g.x, y - g.y) > TAP_MOVE) {
    g.swiping = true;
    window.clearTimeout(g.timer);
  }
  if (!g.swiping) return;
  if (speed > 0.05) slide(speed);
  // A fine ripple: a light tick every ~48 px travelled, stronger when faster.
  g.travelled += step;
  if (g.travelled > 48) {
    g.travelled = 0;
    haptic("tick", Math.min(0.5, 0.12 + speed * 0.15));
  }
}
function end() {
  const g = gesture;
  gesture = null;
  if (!g) return;
  window.clearTimeout(g.timer);
  if (!g.swiping) tap(g);
  else {
    endSlide();
    haptic("edge", 0.2);
  }
}

// Touch: touchmove keeps coming while the page scrolls (pointer events stop with pointercancel,
// which is why swipes were often silent). Mouse/pen: pointer events.
const onTouchStart = (e: TouchEvent) => e.touches.length === 1 && begin(e.touches[0].clientX, e.touches[0].clientY, e.target);
const onTouchMove = (e: TouchEvent) => e.touches[0] && move(e.touches[0].clientX, e.touches[0].clientY);
const onTouchEnd = (e: TouchEvent) => e.touches.length === 0 && end();
const onPointerDown = (e: PointerEvent) => e.pointerType !== "touch" && begin(e.clientX, e.clientY, e.target);
const onPointerMove = (e: PointerEvent) => e.pointerType !== "touch" && e.buttons !== 0 && move(e.clientX, e.clientY);
const onPointerUp = (e: PointerEvent) => e.pointerType !== "touch" && end();

function glassSounds(on: boolean) {
  if (on === soundsOn) return;
  soundsOn = on;
  const opts = { passive: true, capture: true };
  const method = on ? "addEventListener" : "removeEventListener";
  window[method]("touchstart", onTouchStart as EventListener, opts);
  window[method]("touchmove", onTouchMove as EventListener, opts);
  window[method]("touchend", onTouchEnd as EventListener, opts);
  window[method]("touchcancel", onTouchEnd as EventListener, opts);
  window[method]("pointerdown", onPointerDown as EventListener, opts);
  window[method]("pointermove", onPointerMove as EventListener, opts);
  window[method]("pointerup", onPointerUp as EventListener, opts);
  if (!on) endSlide();
}
