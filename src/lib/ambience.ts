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

// ───────────── Glass sounds (made with Web Audio, no files) ─────────────

let audio: AudioContext | null = null;
let noise: AudioBuffer | null = null;
let soundsOn = false;

function ctx(): AudioContext | null {
  if (!audio) {
    try {
      audio = new AudioContext();
      noise = audio.createBuffer(1, audio.sampleRate, audio.sampleRate);
      const d = noise.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    } catch {
      return null;
    }
  }
  if (audio.state === "suspended") void audio.resume();
  return audio;
}

/** A light fingertip on glass: a short bright click with a faint ring. */
function tink() {
  const a = ctx();
  if (!a || !noise) return;
  const t = a.currentTime;
  const click = a.createBufferSource();
  click.buffer = noise;
  const bp = a.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = 3800 + Math.random() * 800;
  bp.Q.value = 6;
  const g = a.createGain();
  g.gain.setValueAtTime(0.18, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
  click.connect(bp).connect(g).connect(a.destination);
  click.start(t, Math.random() * 0.5, 0.06);
  const ring = a.createOscillator();
  ring.type = "sine";
  ring.frequency.value = 2200 + Math.random() * 600;
  const rg = a.createGain();
  rg.gain.setValueAtTime(0.025, t);
  rg.gain.exponentialRampToValueAtTime(0.0005, t + 0.35);
  ring.connect(rg).connect(a.destination);
  ring.start(t);
  ring.stop(t + 0.4);
}

/** A finger sliding on glass: filtered noise that follows the finger's speed. */
let swish: { gain: GainNode; filter: BiquadFilterNode; src: AudioBufferSourceNode } | null = null;
let swishStop = 0;
function slide(speed: number) {
  const a = ctx();
  if (!a || !noise) return;
  if (!swish) {
    const src = a.createBufferSource();
    src.buffer = noise;
    src.loop = true;
    const filter = a.createBiquadFilter();
    filter.type = "bandpass";
    filter.Q.value = 1.4;
    const gain = a.createGain();
    gain.gain.value = 0;
    src.connect(filter).connect(gain).connect(a.destination);
    src.start();
    swish = { gain, filter, src };
  }
  const t = a.currentTime;
  const level = Math.min(0.05, speed * 0.012);
  swish.gain.gain.setTargetAtTime(level, t, 0.03);
  swish.filter.frequency.setTargetAtTime(1200 + Math.min(4000, speed * 900), t, 0.05);
  window.clearTimeout(swishStop);
  swishStop = window.setTimeout(() => swish?.gain.gain.setTargetAtTime(0, a.currentTime, 0.06), 70);
}

const TOUCHABLE = "button, a, [role=button], input[type=checkbox], select, .cal-day, .peek-item, .reminder-open, .attach-image-box, .media-grip";
let lastMove: { x: number; y: number; t: number } | null = null;
const onDown = (e: PointerEvent) => {
  lastMove = { x: e.clientX, y: e.clientY, t: performance.now() };
  if ((e.target as HTMLElement | null)?.closest?.(TOUCHABLE)) tink();
};
const onMove = (e: PointerEvent) => {
  if (!lastMove || (e.pointerType === "mouse" && e.buttons === 0)) return;
  const now = performance.now();
  const dt = Math.max(1, now - lastMove.t);
  const speed = Math.hypot(e.clientX - lastMove.x, e.clientY - lastMove.y) / dt;
  lastMove = { x: e.clientX, y: e.clientY, t: now };
  if (speed > 0.15) slide(speed);
};
const onUp = () => (lastMove = null);

function glassSounds(on: boolean) {
  if (on === soundsOn) return;
  soundsOn = on;
  const method = on ? "addEventListener" : "removeEventListener";
  window[method]("pointerdown", onDown as EventListener, { passive: true, capture: true } as AddEventListenerOptions);
  window[method]("pointermove", onMove as EventListener, { passive: true, capture: true } as AddEventListenerOptions);
  window[method]("pointerup", onUp, { capture: true });
  window[method]("pointercancel", onUp, { capture: true });
}
