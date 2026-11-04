/**
 * Where the sun is, worked out on the device (NOAA's solar equations, good to about a minute), so
 * the timestamp colours and the light/dark switch follow the real sunrise and sunset of the place
 * and the time of year: in Rajkot the sun rises at about 07:20 in late December and 06:00 in late
 * June. No network needed.
 */

export interface Coords {
  lat: number;
  lon: number;
}

/** Hapi's home: Rajkot, Gujarat. Used until the device has reported where it is. */
export const RAJKOT: Coords = { lat: 22.3039, lon: 70.8022 };

/** Where the ambience code keeps the device's last location fix. */
export const COORDS_KEY = "dynamic-journal.weather-place";

/** The device's last known place (kept even when it's old: people rarely move far), else Rajkot. */
export function homeCoords(): Coords {
  try {
    const saved = JSON.parse(localStorage.getItem(COORDS_KEY) ?? "null");
    if (saved && Number.isFinite(saved.lat) && Number.isFinite(saved.lon)) return { lat: saved.lat, lon: saved.lon };
  } catch {
    // Fall back to home.
  }
  return RAJKOT;
}

const RAD = Math.PI / 180;
const DAY = 86_400_000;

/** Julian centuries since J2000 for a moment (ms). */
const centuries = (t: number) => (t / DAY + 2440587.5 - 2451545) / 36525;

/** Sun's declination (radians) and the equation of time (minutes) at `t`. */
function sunParams(t: number): { decl: number; eqTime: number } {
  const T = centuries(t);
  const L0 = (280.46646 + T * (36000.76983 + T * 0.0003032)) % 360;
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
  const C = Math.sin(M * RAD) * (1.914602 - T * (0.004817 + 0.000014 * T)) + Math.sin(2 * M * RAD) * (0.019993 - 0.000101 * T) + Math.sin(3 * M * RAD) * 0.000289;
  const trueLong = L0 + C;
  const omega = 125.04 - 1934.136 * T;
  const lambda = trueLong - 0.00569 - 0.00478 * Math.sin(omega * RAD);
  const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(omega * RAD);
  const decl = Math.asin(Math.sin(eps * RAD) * Math.sin(lambda * RAD));
  const y = Math.tan((eps / 2) * RAD) ** 2;
  const eqTime =
    (4 / RAD) *
    (y * Math.sin(2 * L0 * RAD) -
      2 * e * Math.sin(M * RAD) +
      4 * e * y * Math.sin(M * RAD) * Math.cos(2 * L0 * RAD) -
      0.5 * y * y * Math.sin(4 * L0 * RAD) -
      1.25 * e * e * Math.sin(2 * M * RAD));
  return { decl, eqTime };
}

/** The sun's height above the horizon at moment `t` (degrees; negative = below). */
export function sunElevation(t: number, at: Coords = RAJKOT): number {
  const { decl, eqTime } = sunParams(t);
  const d = new Date(t);
  const utcMin = d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60;
  const trueSolar = (((utcMin + eqTime + 4 * at.lon) % 1440) + 1440) % 1440;
  const hourAngle = (trueSolar / 4 - 180) * RAD;
  const lat = at.lat * RAD;
  const cosZ = Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(hourAngle);
  return 90 - Math.acos(Math.max(-1, Math.min(1, cosZ))) / RAD;
}

/** The moment of solar noon (ms) nearest to `t` for the place. */
export function solarNoon(t: number, at: Coords = RAJKOT): number {
  // The UTC date of the place's solar day, then noon on it shifted by longitude and the equation of time.
  const utcDay = Math.floor((t + (at.lon / 360) * DAY) / DAY) * DAY;
  let noon = utcDay + (720 - 4 * at.lon) * 60_000;
  for (let i = 0; i < 2; i++) noon = utcDay + (720 - 4 * at.lon - sunParams(noon).eqTime) * 60_000;
  return noon;
}

/** Minutes from solar noon until the sun is at `elevation` degrees, or null if it never gets there that day. */
function halfArc(noon: number, elevation: number, at: Coords): number | null {
  const { decl } = sunParams(noon);
  const lat = at.lat * RAD;
  const cosH = (Math.sin(elevation * RAD) - Math.sin(lat) * Math.sin(decl)) / (Math.cos(lat) * Math.cos(decl));
  if (cosH < -1 || cosH > 1) return null;
  return (4 * Math.acos(cosH)) / RAD;
}

export interface SunTimes {
  /** First light (civil dawn, sun 6° below), sunrise, solar noon, sunset, last light (civil dusk). ms. */
  dawn: number;
  rise: number;
  noon: number;
  set: number;
  dusk: number;
  /** Nautical dawn/dusk (sun 12° below): when the sky is truly dark. */
  nightEnd: number;
  nightStart: number;
  /** The sun's height at noon (degrees). */
  noonElevation: number;
}

/** Sunrise, sunset and twilight for the day that `t` falls in (the local solar day around it). */
export function sunTimes(t: number, at: Coords = RAJKOT): SunTimes {
  const noon = solarNoon(t, at);
  const around = (elev: number, fallback: number) => {
    const h = halfArc(noon, elev, at) ?? fallback;
    return [noon - h * 60_000, noon + h * 60_000];
  };
  // -0.833°: the sun's upper edge on the horizon, with the air's bending of light.
  const [rise, set] = around(-0.833, 360);
  const [dawn, dusk] = around(-6, 390);
  const [nightEnd, nightStart] = around(-12, 420);
  return { dawn, rise, noon, set, dusk, nightEnd, nightStart, noonElevation: sunElevation(noon, at) };
}

/** Sunrise and sunset for the local calendar day of `date` (ms). */
export function sunForDay(date: Date, at: Coords = RAJKOT): SunTimes {
  const midday = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12).getTime();
  return sunTimes(midday, at);
}
