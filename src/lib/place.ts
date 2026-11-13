/**
 * 📍 One tap: where you are now, as a line in the note ("📍 Kalavad Road, Rajkot, Gujarat · 22.29158, 70.78072").
 * The phone asks for a fresh precise fix (GPS when it's on, else Wi-Fi/cell); the Mac asks the
 * system. The place's name comes from BigDataCloud's free client-side lookup (no key, no account);
 * without the internet only the coordinates are written.
 */

export interface Fix {
  lat: number;
  lon: number;
}

/** A fresh fix from this device, or null (location off, refused, or nothing within 25 s). */
export function freshFix(): Promise<Fix | null> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => resolve(null), 25_000);
    const done = (v: Fix | null) => (window.clearTimeout(timer), resolve(v));
    const bridge = window.JournalLocation;
    if (bridge?.precise) {
      const id = `place-${Date.now()}`;
      const prev = window.__journalLocation;
      window.__journalLocation = (got, loc) => {
        if (got !== id) return prev?.(got, loc);
        window.__journalLocation = prev;
        done(loc);
      };
      bridge.precise(id);
    } else if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (p) => done({ lat: p.coords.latitude, lon: p.coords.longitude }),
        () => done(null),
        { enableHighAccuracy: true, maximumAge: 60_000, timeout: 20_000 },
      );
    } else done(null);
  });
}

/** "Kalavad Road, Rajkot, Gujarat" from a lookup reply: the most specific names first, no repeats. */
export function placeName(r: { locality?: string; city?: string; principalSubdivision?: string; countryName?: string; localityInfo?: { informative?: { name?: string; order?: number }[] } }): string {
  const parts = [r.locality, r.city, r.principalSubdivision].map((s) => (s ?? "").trim()).filter(Boolean);
  const out: string[] = [];
  for (const p of parts) if (!out.some((o) => o.toLowerCase() === p.toLowerCase())) out.push(p);
  if (!out.length && r.countryName) out.push(r.countryName);
  return out.join(", ");
}

export const coordsText = (f: Fix) => `${f.lat.toFixed(5)}, ${f.lon.toFixed(5)}`;

/** The line to write, or null when no fix could be had. */
export async function placeLine(): Promise<string | null> {
  const fix = await freshFix();
  if (!fix) return null;
  let name = "";
  try {
    const url = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${fix.lat}&longitude=${fix.lon}&localityLanguage=en`;
    const ctrl = new AbortController();
    const t = window.setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(url, { signal: ctrl.signal });
    window.clearTimeout(t);
    if (r.ok) name = placeName(await r.json());
  } catch {
    // Offline: the coordinates alone.
  }
  return `📍 ${name ? `${name} · ` : ""}${coordsText(fix)}`;
}
