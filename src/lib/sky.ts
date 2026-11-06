import { MONTHS } from "./timestamp";
import { homeCoords, solarNoon, sunElevation, type Coords } from "./solar";

export interface Sky {
  /** Pill background: the colour of the sky at that moment. */
  bg: string;
  /** Text colour that stays readable on `bg`. */
  fg: string;
  icon: string;
  phase: "night" | "dawn" | "day" | "sunset";
}

/**
 * The sky's colour by the sun's height (degrees), morning and evening apart: deep night, dawn pink,
 * orange-white by day, red-orange at sunset, then evening blue darkening back into night. Because
 * it goes by the real sun of the place and day, a 06:45 timestamp is dawn-pink in winter and full
 * morning in summer, and 19:00 is night in December but sunset in June.
 */
const MORNING: [number, string][] = [
  [-18, "#0b1d3a"], [-12, "#10264d"], [-8, "#3b3f78"], [-5, "#c98aa8"], [-2, "#f4a6b8"],
  [2, "#f8bfa6"], [8, "#ffdca8"], [20, "#ffe6b8"], [35, "#fff0d0"], [50, "#fff5e2"], [65, "#fff8ec"],
];
const EVENING: [number, string][] = [
  [-18, "#0b1d3a"], [-15, "#162f5c"], [-12, "#22427c"], [-9, "#33599e"], [-6, "#4a78c2"], [-3.5, "#6f9be0"],
  [-1, "#f2603a"], [3, "#ff8c4a"], [10, "#ffc77d"], [20, "#ffe4b5"], [35, "#ffefd2"], [50, "#fff4e0"], [65, "#fff8ec"],
];

const ICONS: Record<Sky["phase"], string> = { night: "🌙", dawn: "🌅", day: "☀️", sunset: "🌇" };

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

function colourAt(stops: [number, string][], elev: number): string {
  if (elev <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    const [e1, c1] = stops[i];
    if (elev > e1) continue;
    const [e0, c0] = stops[i - 1];
    const t = (elev - e0) / (e1 - e0);
    const a = rgb(c0);
    const b = rgb(c1);
    return "#" + a.map((v, k) => Math.round(v + (b[k] - v) * t).toString(16).padStart(2, "0")).join("");
  }
  return stops[stops.length - 1][1];
}

/** Perceived brightness of a #rrggbb colour, 0 (black) to 1 (white). */
function brightness(hex: string): number {
  const [r, g, b] = rgb(hex).map((v) => v / 255);
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** Colour, text colour and icon for a moment (ms or Date), from the sun's real height where the device is. */
export function skyAt(when: number | Date, at: Coords = homeCoords()): Sky {
  const t = typeof when === "number" ? when : when.getTime();
  const elev = sunElevation(t, at);
  const morning = t < solarNoon(t, at);
  const bg = colourAt(morning ? MORNING : EVENING, elev);
  const phase: Sky["phase"] = morning
    ? elev < -8 ? "night" : elev < 6 ? "dawn" : "day"
    : elev < -6 ? "night" : elev < 10 ? "sunset" : "day";
  return { bg, fg: brightness(bg) > 0.6 ? "#3a2a12" : "#f4f7ff", icon: ICONS[phase], phase };
}

/** The sky for a timestamp's parts ("4", "November", "2026", "07", "12"). */
export function skyForStamp(day: string, month: string, year: string, hour: string, minute: string): Sky {
  const m = Math.max(0, MONTHS.indexOf(month));
  return skyAt(new Date(Number(year), m, Number(day), Number(hour), Number(minute)));
}

/** The sky at `hour` (0–23, may be fractional) today. Prefer skyAt when the date is known. */
export function skyFor(hour: number, day: Date = new Date()): Sky {
  const h = ((hour % 24) + 24) % 24;
  return skyAt(new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(h), Math.round((h % 1) * 60)));
}
