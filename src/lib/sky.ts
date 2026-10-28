export interface Sky {
  /** Pill background: the colour of the sky at that hour. */
  bg: string;
  /** Text colour that stays readable on `bg`. */
  fg: string;
  icon: string;
  phase: "night" | "dawn" | "day" | "sunset";
}

// One sky colour per hour, midnight first: deep night, dawn pink, orange-white
// midday, red-orange sunset, then evening blue darkening back into night.
const SKY_BY_HOUR = [
  "#0b1d3a", "#0b1d3a", "#0d2144", "#10264d", "#162f5c", // 0–4 night
  "#f4a6b8", "#f8bfa6", // 5–6 dawn
  "#ffdca8", "#ffe6b8", "#fff0d0", "#fff5e2", // 7–10 morning
  "#fff8ec", "#fff8ec", "#fff4e0", "#ffefd2", "#ffe4b5", // 11–15 midday
  "#ffc77d", // 16 late afternoon
  "#ff8c4a", "#f2603a", // 17–18 sunset
  "#6f9be0", "#4a78c2", "#33599e", "#22427c", "#162f5c", // 19–23 evening into night
];

function phase(hour: number): Sky["phase"] {
  if (hour >= 5 && hour < 7) return "dawn";
  if (hour >= 7 && hour < 17) return "day";
  if (hour >= 17 && hour < 19) return "sunset";
  return "night";
}

const ICONS: Record<Sky["phase"], string> = { night: "🌙", dawn: "🌅", day: "☀️", sunset: "🌇" };

/** Perceived brightness of a #rrggbb colour, 0 (black) to 1 (white). */
function brightness(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** Colour, text colour and icon for a timestamp taken at `hour` (0–23). */
export function skyFor(hour: number): Sky {
  const h = ((Math.floor(hour) % 24) + 24) % 24;
  const bg = SKY_BY_HOUR[h];
  const p = phase(h);
  return { bg, fg: brightness(bg) > 0.6 ? "#3a2a12" : "#f4f7ff", icon: ICONS[p], phase: p };
}
