/**
 * Soft UI light (the neumorphism theme): where the light comes from, how long and soft the shadows
 * are, and what colour the light is, from the real sun (or moon) position and the weather.
 *
 * The screen is treated like a wall facing the sky: the sun rises on the left, is overhead at noon
 * and sets on the right, so shapes cast their shadow to the right in the morning, straight down at
 * noon and to the left in the evening. A low sun casts longer, warmer shadows; clouds and rain
 * spread the light out, so shadows get short, blurry and faint.
 */
import type { Weather } from "./ambience";

export interface SoftLight {
  /** Shadow offset of a full-size raised shape, px (light comes from the opposite side). */
  x: number;
  y: number;
  /** Shadow blur, px. */
  blur: number;
  /** 0–1: how dark the shade and how bright the highlight are. */
  strength: number;
  /** Light colour, "r, g, b". */
  tint: string;
  /** How much the light colours the surface, %. */
  tintAmt: number;
  /** How much the light colours the highlights, %. */
  glow: number;
  /** Where the light source sits on the screen, % (may be off-screen). */
  sunX: number;
  sunY: number;
  phase: "day" | "twilight" | "night";
}

const BASE = 7; // px: the theme's resting shadow offset
const BLUR = 16;
const TWILIGHT = 45 * 60_000; // ms after sunset / before sunrise that still glows

type RGB = [number, number, number];
const NOON: RGB = [255, 248, 236];
const GOLDEN: RGB = [255, 168, 92];
const DUSK: RGB = [246, 140, 168];
const MOON: RGB = [146, 170, 255];
const OVERCAST: RGB = [200, 207, 218];
const RAIN: RGB = [168, 188, 214];

const mix = (a: RGB, b: RGB, t: number): RGB => [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * t)) as RGB;
const r1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Light at `now` (ms) for a day whose sun rises at `rise` and sets at `set` (ms, same day).
 * Weather null = unknown, treated as clear.
 */
export function softLightAt(now: number, rise: number, set: number, weather: Weather): SoftLight {
  const DAY = 24 * 3600_000;
  let p: number; // 0 → 1 across the arc of the sun (day) or moon (night)
  let phase: SoftLight["phase"];
  let dawn = false;
  if (now >= rise && now < set) {
    p = (now - rise) / (set - rise);
    phase = "day";
  } else {
    const from = now >= set ? set : set - DAY;
    const to = now >= set ? rise + DAY : rise;
    p = (now - from) / (to - from);
    phase = now - from < TWILIGHT || to - now < TWILIGHT ? "twilight" : "night";
    dawn = to - now < TWILIGHT;
  }
  p = Math.min(1, Math.max(0, p));
  const e = Math.sin(Math.PI * p); // elevation: 0 at the horizon, 1 overhead
  // Direction towards the light, in screen terms (x right, y down). Always a bit from above, as
  // light from straight beside a screen looks wrong.
  let lx = -Math.cos(Math.PI * p) * 0.9;
  let ly = -(0.3 + 0.7 * e);
  const len = Math.hypot(lx, ly);
  lx /= len;
  ly /= len;

  let dist = BASE * (0.8 + 0.7 * (1 - e)); // a low sun makes long shadows
  let blur = BLUR * (0.85 + 0.3 * e);
  let strength: number;
  let tint: RGB;
  let tintAmt: number;
  let glow: number;
  if (phase === "day") {
    strength = 0.85 + 0.15 * e;
    tint = mix(GOLDEN, NOON, Math.pow(e, 0.6));
    tintAmt = 3 + 6 * (1 - e);
    glow = 8 + 22 * (1 - e);
  } else if (phase === "twilight") {
    // The sun is just below the horizon: glow on its side, faint and pink.
    lx = dawn ? -0.9 : 0.9; // before sunrise the glow is on the rising (left) side
    ly = -0.44;
    const l2 = Math.hypot(lx, ly);
    lx /= l2;
    ly /= l2;
    dist = BASE * 1.1;
    strength = 0.7;
    tint = DUSK;
    tintAmt = 7;
    glow = 28;
  } else {
    dist *= 0.6;
    blur *= 0.9;
    strength = 0.6;
    tint = MOON;
    tintAmt = 6;
    glow = 25;
  }

  if (weather === "cloudy") {
    dist *= 0.45;
    blur *= 1.7;
    strength *= 0.72;
    tint = mix(tint, OVERCAST, 0.7);
    tintAmt *= 0.6;
    glow *= 0.4;
  } else if (weather === "rain") {
    dist *= 0.35;
    blur *= 2;
    strength *= 0.6;
    tint = mix(tint, RAIN, 0.8);
    tintAmt = Math.max(tintAmt * 0.6, 4);
    glow *= 0.35;
  }

  return {
    x: r1(-lx * dist),
    y: r1(-ly * dist),
    blur: r1(blur),
    strength: Math.round(strength * 100) / 100,
    tint: tint.join(", "),
    tintAmt: r1(tintAmt),
    glow: r1(glow),
    sunX: Math.round(50 - Math.cos(Math.PI * p) * 55),
    sunY: Math.round(-12 + (1 - e) * 42),
    phase,
  };
}
