import { atRest, REST_EVENT } from "./power";
/**
 * Ambience (all optional, Settings › Look and feel):
 * - the colours brighten and dim with the time of day,
 * - the weather shows on the glass: sun rays when sunny, drifting cloud when cloudy, drops
 *   running down the glass when it rains,
 * - glass sounds: a soft "tink" when an element is touched, a breathy swish when a finger slides.
 * Weather comes from Open-Meteo (no key) for the rough location of this internet connection.
 */

import { softLightAt, type ToneMode } from "./softLight";
import { COORDS_KEY, homeCoords, sunElevation, sunForDay } from "./solar";

const softTheme = () => document.documentElement.dataset.theme === "neu";

export interface AmbienceSettings {
  daylight: boolean;
  weather: boolean;
  sounds: boolean;
  /** Soft UI with the light following the sun: light by day + dark at night, or one of them all day. */
  tone: ToneMode;
}

const KEY = "dynamic-journal.ambience";
const DEFAULTS: AmbienceSettings = { daylight: true, weather: true, sounds: false, tone: "both" };

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

/** 0 at night, 1 at midday, from the sun's real height where the device is (Rajkot until it's known). */
export function daylightAt(date: Date): number {
  const elev = sunElevation(date.getTime(), homeCoords());
  const noon = sunForDay(date, homeCoords()).noonElevation;
  // Starts brightening in civil twilight (-6°), full by the day's highest sun.
  return Math.max(0, Math.min(1, Math.sin((Math.max(0, elev + 6) / (noon + 6)) * (Math.PI / 2))));
}

let weather: Weather = null;
let weatherAt = 0;

declare global {
  interface Window {
    JournalLocation?: { request(id: string): void };
    __journalLocation?: (id: string, loc: { lat: number; lon: number } | null) => void;
  }
}


/**
 * Where this device is, roughly: the phone asks for its location once (coarse, a few seconds, then
 * it's off again); the Mac asks the system; the internet connection's address only as a last resort.
 * Remembered for 6 hours, so the location is rarely asked for.
 */
async function deviceCoords(): Promise<{ lat: number; lon: number } | null> {
  try {
    const saved = JSON.parse(localStorage.getItem(COORDS_KEY) ?? "null");
    if (saved && Date.now() - saved.at < 6 * 3600_000) return saved;
  } catch {
    // Ask again.
  }
  const fromDevice = await new Promise<{ lat: number; lon: number } | null>((resolve) => {
    const timer = window.setTimeout(() => resolve(null), 20_000);
    const done = (v: { lat: number; lon: number } | null) => (window.clearTimeout(timer), resolve(v));
    if (window.JournalLocation) {
      const id = String(Date.now());
      window.__journalLocation = (got, loc) => got === id && done(loc);
      window.JournalLocation.request(id);
    } else if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (p) => done({ lat: p.coords.latitude, lon: p.coords.longitude }),
        () => done(null),
        { enableHighAccuracy: false, maximumAge: 30 * 60_000, timeout: 15_000 },
      );
    } else done(null);
  });
  let coords = fromDevice;
  if (!coords) {
    try {
      const geo = await (await fetch("https://get.geojs.io/v1/ip/geo.json")).json();
      coords = { lat: Number(geo.latitude), lon: Number(geo.longitude) };
    } catch {
      return null;
    }
  }
  try {
    // Only device fixes are kept for long; a guess from the connection is tried again next time.
    if (fromDevice) localStorage.setItem(COORDS_KEY, JSON.stringify({ ...coords, at: Date.now() }));
  } catch {
    // Only a convenience.
  }
  return coords;
}

/** Is the sun up now? Worked out for the place and day, so it follows the seasons. */
export function sunIsUp(now: Date): boolean {
  const { rise, set } = todaySun(now);
  return now.getTime() >= rise && now.getTime() < set;
}

/** Today's sunrise and sunset (ms) where the device is (Rajkot until it's known), plus how long the glow lasts. */
export function todaySun(now: Date): { rise: number; set: number; twilight: number } {
  const t = sunForDay(now, homeCoords());
  return { rise: t.rise, set: t.set, twilight: Math.max(20 * 60_000, t.nightStart - t.set) };
}

/** Colours for the two tones the soft surface moves between (contrast checked at the dimmest and
 * most tinted surface of each: text ≥ 9:1, muted, links, tags and reminders ≥ 5:1). */
const TONES = {
  light: {
    "--text": "#1e2430",
    "--muted": "#3f4859",
    "--accent": "#2a3db0",
    "--tag": "#6e3b00",
    "--reminder": "#7a3604",
    "--heat-rgb": "91, 33, 182",
    "--mark": "#fde68a",
    "--border": "color-mix(in srgb, var(--bg) 82%, #6b7891)",
    "--panel": "color-mix(in srgb, var(--bg) 93%, #7d8ba3)",
    "--heat-empty": "color-mix(in srgb, var(--bg) 90%, #7d8ba3)",
    "--neu-shade-a": "0.7",
    "--neu-hi-a": "0.8",
    "--neu-knob": "#f1f3f6",
    "--neu-tint-k": "1",
    "--neu-sun-a": "0.07",
    "--neu-overlay": "0 18px 50px rgba(30, 40, 60, 0.28)",
  },
  dark: {
    "--text": "#e8eaef",
    "--muted": "#a9b0bd",
    "--accent": "#9db0ff",
    "--tag": "#f0a54a",
    "--reminder": "#f59e0b",
    "--heat-rgb": "167, 112, 255",
    "--mark": "rgba(250, 204, 21, 0.35)",
    "--border": "color-mix(in srgb, var(--bg) 85%, #fff)",
    "--panel": "color-mix(in srgb, var(--bg) 92%, #fff)",
    "--heat-empty": "color-mix(in srgb, var(--bg) 93%, #fff)",
    // Strong shade and a clear top-left highlight: on a dark surface faint ones read as flat.
    "--neu-shade-a": "0.8",
    "--neu-hi-a": "0.13",
    "--neu-knob": "#e8eaef",
    "--neu-tint-k": "0.5",
    "--neu-sun-a": "0.05",
    "--neu-overlay": "0 18px 50px rgba(0, 0, 0, 0.55)",
  },
} as const;

const LIGHT_PROPS = ["--neu-x", "--neu-y", "--neu-blur", "--neu-strength", "--neu-tint", "--neu-tint-amt", "--neu-glow", "--sun-x", "--sun-y", "--neu-base", "--neu-shade-rgb", "color-scheme", ...Object.keys(TONES.light)];
let lightApplied = false;

/** Soft UI: shadows turn with the sun and take the colour of the light (Settings → brightness). */
function applySoftLight() {
  const root = document.documentElement;
  const s = ambienceSettings();
  if (!softTheme() || !s.daylight) {
    for (const p of LIGHT_PROPS) root.style.removeProperty(p);
    root.removeAttribute("data-light");
    root.removeAttribute("data-tone");
    lightApplied = false;
    return;
  }
  // The first time (app start, theme switched on) the light is set at once; after that every change
  // (the sun moving, sunset, clouds coming) glides over a few seconds (transitions in themes.css).
  if (!lightApplied) {
    root.classList.add("neu-instant");
    requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove("neu-instant")));
  }
  lightApplied = true;
  const now = new Date();
  const { rise, set, twilight } = todaySun(now);
  const l = softLightAt(now.getTime(), rise, set, s.weather ? weather : null, s.tone, twilight);
  const set1 = (k: string, v: string) => root.style.setProperty(k, v);
  set1("--neu-x", `${l.x}px`);
  set1("--neu-y", `${l.y}px`);
  set1("--neu-blur", `${l.blur}px`);
  set1("--neu-strength", String(l.strength));
  set1("--neu-tint", l.tint);
  set1("--neu-tint-amt", `${l.tintAmt}%`);
  set1("--neu-glow", `${l.glow}%`);
  set1("--sun-x", `${l.sunX}%`);
  set1("--sun-y", `${l.sunY}%`);
  root.dataset.light = l.phase;
  root.dataset.tone = l.tone;
  set1("--neu-base", l.base);
  // The shade is the surface itself, darker (so it never looks grey or dirty on a tinted surface).
  const b = [1, 3, 5].map((i) => parseInt(l.base.slice(i, i + 2), 16));
  set1("--neu-shade-rgb", l.tone === "light" ? b.map((v) => Math.round(v * 0.6)).join(", ") : "0, 0, 0");
  set1("color-scheme", l.tone);
  for (const [k, v] of Object.entries(TONES[l.tone])) set1(k, v);
}

async function fetchWeather(): Promise<Weather> {
  if (Date.now() - weatherAt < 30 * 60_000) return weather;
  weatherAt = Date.now();
  try {
    const at = await deviceCoords();
    if (!at) return (weather = null);
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${at.lat.toFixed(3)}&longitude=${at.lon.toFixed(3)}&current=weather_code&timezone=auto&forecast_days=1`;
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
    // At rest (no touch for a few seconds) or hidden, the drops hold still and no frames are asked for.
    if (atRest() || document.hidden) {
      frame = 0;
      return;
    }
    frame = requestAnimationFrame(tick);
    // ~30 fps is plenty for drops, and half the work on the phone.
    if (t - last < 33) return;
    last = t;
    ctx.clearRect(0, 0, w, h);
    const soft = softTheme();
    let sx = 3;
    let sy = 3;
    let hi = "rgba(255, 255, 255, 0.55)";
    let lo = "rgba(60, 75, 100, 0.22)";
    if (soft) {
      const tone = document.documentElement.dataset.tone;
      if (tone ? tone === "dark" : window.matchMedia?.("(prefers-color-scheme: dark)").matches) {
        hi = "rgba(255, 255, 255, 0.09)";
        lo = "rgba(0, 0, 0, 0.35)";
      }
      const css = getComputedStyle(document.documentElement);
      sx = parseFloat(css.getPropertyValue("--neu-x")) || 3;
      sy = parseFloat(css.getPropertyValue("--neu-y")) || 3;
    }
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
      if (soft) {
        // Soft UI: a raised bead of water on the surface, lit from the same side as everything else.
        const k = d.r / Math.max(1, Math.hypot(sx, sy));
        ctx.fillStyle = lo;
        ctx.beginPath();
        ctx.ellipse(d.x + sx * k * 0.5, d.y + sy * k * 0.5, d.r, d.r * 1.15, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = hi;
        ctx.beginPath();
        ctx.ellipse(d.x - sx * k * 0.4, d.y - sy * k * 0.4, d.r * 0.9, d.r * 1.05, 0, 0, Math.PI * 2);
        ctx.fill();
        if (d.y > h + 10) drops[i] = { ...spawn(), y: Math.random() * h * 0.3 };
        continue;
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
  const wake = () => !frame && !atRest() && (frame = requestAnimationFrame(tick));
  window.addEventListener(REST_EVENT, wake);
  document.addEventListener("visibilitychange", wake);
  return {
    stop: () => {
      cancelAnimationFrame(frame);
      window.removeEventListener(REST_EVENT, wake);
      document.removeEventListener("visibilitychange", wake);
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
    root.classList.remove("weather-clear", "weather-cloudy", "weather-rain", "weather-night");
    if (w) root.classList.add(`weather-${w}`);
    // No sun at night: a clear night sky shows the moon and a few stars instead.
    if (w && !sunIsUp(new Date())) root.classList.add("weather-night");
    const wantRain = w === "rain" && !reducedMotion();
    if (wantRain && !rain) rain = startRain();
    if (!wantRain && rain) (rain.stop(), (rain = null));
  };
  applySoftLight();
  if (s.weather) void fetchWeather().then((w) => (show(ambienceSettings().weather ? w : null), applySoftLight()));
  else show(null);
  glassSounds(s.sounds);
}

let started = false;
/** Starts ambience and keeps it current (every 10 minutes, and when the app comes back). */
export function startAmbience() {
  if (started || typeof window === "undefined") return;
  started = true;
  applyAmbience();
  // Only while the app is on screen (it catches up when it comes back): no weather checks in the background.
  window.setInterval(() => !document.hidden && applyAmbience(), 10 * 60_000);
  // Soft UI shadows follow the sun minute by minute (cheap: a few CSS variables).
  window.setInterval(() => !document.hidden && applySoftLight(), 60_000);
  window.addEventListener("journal:theme", applyAmbience);
  window.addEventListener("storage", (e) => e.key === "journal.theme" && applyAmbience());
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
  // An open AudioContext keeps the phone's audio output (and Bluetooth audio) awake, playing
  // silence, for as long as it runs: it's suspended a moment after the last sound.
  window.clearTimeout(audioIdle);
  audioIdle = window.setTimeout(() => audio?.state === "running" && void audio.suspend(), 1500);
  return audio;
}
let audioIdle = 0;
if (typeof document !== "undefined")
  document.addEventListener("visibilitychange", () => document.hidden && audio?.state === "running" && void audio.suspend());

const haptic = (kind: "tap" | "tick" | "press" | "edge", strength: number) => {
  try {
    window.JournalHaptics?.play(kind, strength);
  } catch {
    // No haptics here.
  }
};

/**
 * Soft UI: pressing a soft, rubbery surface. A muffled low thump (a sine that drops in pitch, like a
 * cushion giving way) with a breath of felt-like noise; no ring.
 */
function softPress(onButton: boolean) {
  const a = ctx();
  if (!a || !noise) return;
  const t = a.currentTime + 0.005;
  const o = a.createOscillator();
  o.type = "sine";
  o.frequency.setValueAtTime(onButton ? 210 : 170, t);
  o.frequency.exponentialRampToValueAtTime(onButton ? 95 : 80, t + 0.09);
  const g = a.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(onButton ? 0.2 : 0.11, t + 0.006);
  g.gain.exponentialRampToValueAtTime(0.0005, t + 0.12);
  o.connect(g).connect(a.destination);
  o.start(t);
  o.stop(t + 0.14);
  const n = a.createBufferSource();
  n.buffer = noise;
  const lp = a.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 650 + Math.random() * 150;
  const ng = a.createGain();
  ng.gain.setValueAtTime(0, t);
  ng.gain.linearRampToValueAtTime(onButton ? 0.16 : 0.09, t + 0.004);
  ng.gain.exponentialRampToValueAtTime(0.0005, t + 0.06);
  n.connect(lp).connect(ng).connect(a.destination);
  n.start(t, Math.random(), 0.08);
}

/** Soft UI: the shape springing back up when the finger lifts, a tiny airy "pop". */
function softRelease() {
  const a = ctx();
  if (!a) return;
  const t = a.currentTime + 0.005;
  const o = a.createOscillator();
  o.type = "sine";
  o.frequency.setValueAtTime(320, t);
  o.frequency.exponentialRampToValueAtTime(520, t + 0.05);
  const g = a.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.05, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0003, t + 0.08);
  o.connect(g).connect(a.destination);
  o.start(t);
  o.stop(t + 0.1);
}

/** A fingertip landing on glass: a soft, short knock with a faint glassy ring. */
function tink(onButton: boolean) {
  if (softTheme()) return softPress(onButton);
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
let swish: { gain: GainNode; band: BiquadFilterNode; hp: BiquadFilterNode; src: AudioBufferSourceNode } | null = null;
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
    swish = { gain, band, hp, src };
  }
  const t = a.currentTime;
  // px/ms: ~0.2 slow drag, ~2 fast flick.
  // Soft UI: a finger on a matte, rubbery surface is lower and quieter than on glass.
  const soft = softTheme();
  swish.hp.frequency.value = soft ? 150 : 600;
  const level = Math.min(soft ? 0.06 : 0.09, 0.012 + speed * (soft ? 0.02 : 0.03));
  swish.gain.gain.setTargetAtTime(level, t, 0.025);
  swish.band.frequency.setTargetAtTime(soft ? 380 + Math.min(900, speed * 450) : 900 + Math.min(3200, speed * 1500), t, 0.04);
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
  if (!g.swiping) {
    tap(g);
    if (g.target && softTheme()) window.setTimeout(softRelease, 40);
  }
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
